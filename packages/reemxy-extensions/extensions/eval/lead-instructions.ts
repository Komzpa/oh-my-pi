#!/usr/bin/env bun
/** Opt-in, single-turn provider eval. No returned tool is executed. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ToolSession } from "../../../coding-agent/src/tools";
import { TodoTool } from "../../../coding-agent/src/tools/todo";
import { ReadTool } from "../../../coding-agent/src/tools/read";
import { WriteTool } from "../../../coding-agent/src/tools/write";
import { AskTool } from "../../../coding-agent/src/tools/ask";
import { WaitTool } from "../../../coding-agent/src/tools/wait";
import { getTaskSchema } from "../../../coding-agent/src/task/types";
import { getAgentDir, isEnoent, prompt, logger } from "@oh-my-pi/pi-utils";
import taskDescription from "../../../coding-agent/src/prompts/tools/task.md" with { type: "text" };
import readDescription from "../../../coding-agent/src/prompts/tools/read.md" with { type: "text" };
import turnTemplate from "./lead-instructions-turn.md" with { type: "text" };
import { leadInstructionScenarios } from "../lead-instructions.scenarios";
import { CODEX_LB_PROVIDER } from "../codex_lb_provider";

logger.setTransports({ file: false }); // Evaluation must not create ~/.omp log files.

interface Scenario {
	id: string;
	context: string;
	todoDescription?: string;
	expected: { tool: string; args: Record<string, unknown> } | null;
}
interface Budget {
	calls: number;
	reservedTokens: number;
}
interface Result {
	id: string;
	aliasOf?: string;
	pass: boolean;
	expected: Scenario["expected"];
	firstToolCall?: ToolCall;
	stopReason: string;
	usage: unknown;
	error?: string;
	contextHash: string;
	context: string;
	responseText: string;
}
function contains(actual: unknown, expected: unknown, taskBrief = false, key = ""): boolean {
	if (taskBrief && key === "task" && typeof actual === "string" && typeof expected === "string")
		return actual.includes(expected);
	if (typeof expected !== "object" || expected === null) return actual === expected;
	if (typeof actual !== "object" || actual === null) return false;
	return Object.entries(expected).every(([key, value]) => contains(Reflect.get(actual, key), value, taskBrief, key));
}
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		help: { type: "boolean" },
		contexts: { type: "string" },
		output: { type: "string", default: "reports/lead-instructions/current.json" },
		model: { type: "string", default: "codex-lb/gpt-6-luna" },
		"budget-file": { type: "string", default: "reports/lead-instructions/budget.json" },
		"max-calls": { type: "string", default: "140" },
		"max-tokens": { type: "string", default: "5000000" },
	},
});
if (values.help) {
	console.log(
		"bun run eval:lead-instructions [--model provider/id] [--contexts scenarios.json] [--output receipt.json] [--budget-file shared-before-after-budget.json] [--max-calls 140] [--max-tokens 5000000]",
	);
	process.exit(0);
}
const scenarios = (
	values.contexts ? await Bun.file(values.contexts).json() : await leadInstructionScenarios()
) as Scenario[];
if (
	!Array.isArray(scenarios) ||
	scenarios.some(
		s => !s.id || typeof s.context !== "string" || !(s.expected === null || (s.expected?.tool && s.expected.args)),
	)
) {
	throw new Error("Contexts must contain {id,context,expected:{tool,args}|null}[]");
}
const maxCalls = Number(values["max-calls"]);
const maxTokens = Number(values["max-tokens"]);
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1)
	throw new Error("Budgets must be positive integers");
await fs.mkdir(path.dirname(values["budget-file"]), { recursive: true });
const budgetLock = `${values["budget-file"]}.lock`;
await fs.mkdir(budgetLock); // A second runner must not spend the same aggregate budget.
await using budgetLease = {
	[Symbol.asyncDispose]: () => fs.rm(budgetLock, { recursive: true, force: true }),
};
let budget: Budget = { calls: 0, reservedTokens: 0 };
try {
	budget = await Bun.file(values["budget-file"]).json();
} catch (error) {
	if (!isEnoent(error)) throw error;
}
if (await Bun.file(values.output).exists())
	throw new Error("Receipt already exists; preserve it and choose a new --output path (keep the shared budget file)");
const outputCap = 1024;
const metadataSession = {} as ToolSession; // Constructors only: no execute or live session.
const todo = new TodoTool(metadataSession);
const tools: Tool[] = [
	{ name: todo.name, description: scenarios[0]?.todoDescription ?? todo.description, parameters: todo.parameters },
	new AskTool(metadataSession),
	new WriteTool(metadataSession),
	new WaitTool(metadataSession),
];
// Reuse runtime schemas. Read's description getter needs live settings, so render its static template here.
const read = new ReadTool(metadataSession);
tools.push({ name: read.name, description: prompt.render(readDescription), parameters: read.parameters });
tools.push({
	name: "task",
	description: prompt.render(taskDescription, { batchEnabled: true, asyncEnabled: true, defaultAgent: "task" }),
	parameters: getTaskSchema({ isolationEnabled: false, batchEnabled: true, effortEnabled: true }),
});
const groups = new Map<string, { scenario: Scenario; aliases: Scenario[]; context: string }>();
for (const scenario of scenarios) {
	const context = prompt.render(turnTemplate, { context: scenario.context });
	const group = groups.get(context);
	if (group) {
		group.aliases.push(scenario);
	} else groups.set(context, { scenario, aliases: [], context });
}
const requests = [...groups.values()];
// One UTF-8 byte per input token is a conservative bound; output reservation covers every request.
const toolBytes = Buffer.byteLength(
	JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, schema: toolWireSchema(t) }))),
);
const reserves = requests.map(r => Buffer.byteLength(r.context) + toolBytes + outputCap + 512);
if (
	budget.calls + requests.length > maxCalls ||
	budget.reservedTokens + reserves.reduce((a, b) => a + b, 0) > maxTokens
)
	throw new Error("Whole-run aggregate budget preflight failed; preserve prior receipts and raise an explicit budget");
console.log(
	JSON.stringify({
		preflight: {
			scenarios: scenarios.length,
			uniqueContexts: requests.length,
			maxCalls,
			maxTokens,
			conservativeReservedTokens: reserves.reduce((a, b) => a + b, 0),
			prior: budget,
			concurrency: 1,
			retries: 0,
			model: values.model,
		},
	}),
);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lead-eval-"));
const results: Result[] = [];
let auth: AuthStorage | undefined;
try {
	const modelsPath = path.join(dir, "models.yml");
	try {
		await Bun.write(modelsPath, await Bun.file(path.join(getAgentDir(), "models.yml")).text());
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	auth = await AuthStorage.create(path.join(dir, "auth.db"));
	const registry = new ModelRegistry(auth, modelsPath, { cacheDbPath: path.join(dir, "models.db") });
	registry.registerProvider("codex-lb", CODEX_LB_PROVIDER);
	const slash = values.model.indexOf("/");
	if (slash < 1) throw new Error("Model must be provider/id");
	const model = registry.find(values.model.slice(0, slash), values.model.slice(slash + 1));
	if (!model) throw new Error(`Model unavailable in existing configuration: ${values.model}`);
	const credentials = await registry.getApiKeyAndHeaders(model);
	if (!credentials.ok) throw new Error(credentials.error);
	for (let i = 0; i < requests.length; i++) {
		const { scenario, aliases, context } = requests[i];
		budget.calls++;
		budget.reservedTokens += reserves[i];
		await Bun.write(values["budget-file"], JSON.stringify(budget, null, 2));
		const response = await stream(
			model,
			{ messages: [{ role: "user", content: context, timestamp: Date.now() }], tools },
			{
				apiKey: credentials.apiKey,
				headers: credentials.headers,
				maxTokens: outputCap,
				maxHttpAttempts: 1,
				signal: AbortSignal.timeout(90000),
			},
		).result();
		const first = response.content.find(b => b.type === "toolCall");
		const passes = (expected: Scenario["expected"]) =>
			response.stopReason !== "error" &&
			response.stopReason !== "aborted" &&
			(expected === null
				? first === undefined || first.name === "wait"
				: expected.tool === "text"
					? first === undefined &&
						response.content.some(
							b =>
								b.type === "text" &&
								b.text.includes("?") &&
								Object.values(expected!.args).every(value =>
									b.text.toLowerCase().includes(String(value).toLowerCase()),
								),
						)
					: first?.name === expected.tool && contains(first.arguments, expected.args, first.name === "task"));
		const pass = passes(scenario.expected);
		const result: Result = {
			id: scenario.id,
			pass,
			expected: scenario.expected,
			firstToolCall: first,
			stopReason: response.stopReason,
			usage: response.usage,
			error: response.errorMessage,
			context,
			responseText: response.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n"),
			contextHash: new Bun.CryptoHasher("sha256").update(context).digest("hex"),
		};
		results.push(
			result,
			...aliases.map(alias => ({
				...result,
				id: alias.id,
				expected: alias.expected,
				pass: passes(alias.expected),
				aliasOf: scenario.id,
			})),
		);
		await Bun.write(
			values.output,
			JSON.stringify({ model: values.model, asOf: new Date().toISOString(), budget, results }, null, 2),
		);
		console.log(`${pass ? "PASS" : "FAIL"}\t${scenario.id}\t${first?.name ?? "no call"}`);
		for (const alias of aliases)
			console.log(`${passes(alias.expected) ? "PASS" : "FAIL"}\t${alias.id}\talias of ${scenario.id}`);
		if (response.stopReason === "error" || response.stopReason === "aborted")
			throw new Error(`Provider stopped at ${scenario.id}; no retries or fallback. Receipt saved.`);
	}
} finally {
	auth?.close();
	await fs.rm(dir, { recursive: true, force: true });
}
if (results.some(r => !r.pass)) process.exitCode = 1;
