#!/usr/bin/env bun
/** Opt-in provider eval. Only native TODO decisions are replayed in disposable state. */
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
import {
	leadInstructionScenarios,
	verifyLeadRoundTrip,
	type LeadInstructionScenario,
} from "../lead-instructions.scenarios";
import { fixNowScenarios } from "../fix-now.scenarios";
import { resourceScopeNotice } from "../agent_router";
import { leadGateScenarios } from "../lead-gates.scenarios";
import { validateToolCall } from "@oh-my-pi/pi-ai/utils/validation";
import { contains, runLeadSequence } from "./lead-sequence";
import { GrepTool } from "../../../coding-agent/src/tools/grep";
import { GlobTool } from "../../../coding-agent/src/tools/glob";
import grepDescription from "../../../coding-agent/src/prompts/tools/grep.md" with { type: "text" };
import globDescription from "../../../coding-agent/src/prompts/tools/glob.md" with { type: "text" };

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
	reservedUsd: number;
}
interface Result {
	id: string;
	aliasOf?: string;
	pass: boolean;
	expected: Scenario["expected"];
	firstToolCall?: ToolCall;
	toolCalls: ToolCall[];
	failure?: string;
	stopReason: string;
	usage: unknown;
	error?: string;
	contextHash: string;
	context: string;
	responseText: string;
}
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		help: { type: "boolean" },
		contexts: { type: "string" },
		"tool-schemas": { type: "string" },
		"pricing-model": { type: "string" },
		output: { type: "string", default: "reports/lead-instructions/current.json" },
		model: { type: "string", default: "codex-lb/gpt-6-luna" },
		"budget-file": { type: "string", default: "reports/lead-instructions/budget.json" },
		"max-calls": { type: "string", default: "140" },
		"max-tokens": { type: "string", default: "5000000" },
		"max-usd": { type: "string", default: "2" },
	},
});
if (values.help) {
	console.log(
		"bun run eval:lead-instructions [--model provider/id] [--contexts scenarios.json] [--tool-schemas union-schemas.json] [--pricing-model provider/id] [--output receipt.json] [--budget-file shared-before-after-budget.json] [--max-calls 140] [--max-tokens 5000000] [--max-usd 2]",
	);
	process.exit(0);
}
const scenarios = (
	values.contexts
		? await Bun.file(values.contexts).json()
		: [...(await leadInstructionScenarios()), ...(await leadGateScenarios()), ...(await fixNowScenarios()), {
			id: "scopegrant-telepathy",
			context: resourceScopeNotice("AdaptiveBatch", { op: "schedule", updates: [{
				task: "Finish assigned worktree edit", resources: ["/fixture/AdaptiveBatch"],
			}] }),
			expected: { tool: "todo", args: { op: "schedule", updates: [{
				task: "Finish assigned worktree edit", resources: ["/fixture/AdaptiveBatch"],
			}] } },
		}]
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
const maxUsd = Number(values["max-usd"]);
if (
	!Number.isSafeInteger(maxCalls) ||
	maxCalls < 1 ||
	!Number.isSafeInteger(maxTokens) ||
	maxTokens < 1 ||
	!Number.isFinite(maxUsd) ||
	maxUsd <= 0
)
	throw new Error("Budgets must be positive integers");
await fs.mkdir(path.dirname(values["budget-file"]), { recursive: true });
const budgetLock = `${values["budget-file"]}.lock`;
await fs.mkdir(budgetLock); // A second runner must not spend the same aggregate budget.
await using budgetLease = {
	[Symbol.asyncDispose]: () => fs.rm(budgetLock, { recursive: true, force: true }),
};
let budget: Budget = { calls: 0, reservedTokens: 0, reservedUsd: 0 };
try {
	budget = await Bun.file(values["budget-file"]).json();
} catch (error) {
	if (!isEnoent(error)) throw error;
}
if (![budget.calls, budget.reservedTokens, budget.reservedUsd].every(value => Number.isFinite(value) && value >= 0))
	throw new Error("Budget receipt lacks valid aggregate reservations; preserve it, do not reset spent budget");
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
for (const [tool, description] of [
	[new GrepTool(metadataSession), grepDescription],
	[new GlobTool(metadataSession), globDescription],
] as const)
	tools.push({ name: tool.name, parameters: tool.parameters, description: prompt.render(description) });
const schemaText = values["tool-schemas"] ? await Bun.file(values["tool-schemas"]).text() : undefined;
const schemaOverrides: Record<string, Tool["parameters"]> = schemaText ? JSON.parse(schemaText) : {};
for (const tool of tools) if (schemaOverrides[tool.name]) tool.parameters = schemaOverrides[tool.name];
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
const reserves = requests.map(r => Buffer.byteLength(r.context) + toolBytes + outputCap + 4096);
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
	await registry.refreshDiscoverableProviders([values.model.split("/")[0]], "online");
	const slash = values.model.indexOf("/");
	if (slash < 1) throw new Error("Model must be provider/id");
	const model = registry.find(values.model.slice(0, slash), values.model.slice(slash + 1));
	if (!model) throw new Error(`Model unavailable in existing configuration: ${values.model}`);
	const credentials = await registry.getApiKeyAndHeaders(model);
	if (!credentials.ok) throw new Error(credentials.error);
	const pricingSelector = values["pricing-model"];
	const pricingSlash = pricingSelector?.indexOf("/") ?? -1;
	const pricingModel = pricingSelector
		? registry.find(pricingSelector.slice(0, pricingSlash), pricingSelector.slice(pricingSlash + 1))
		: model;
	if (!pricingModel) throw new Error("Pricing reference unavailable");
	const cost = pricingModel.cost;
	if (
		![cost.input, cost.output, cost.cacheWrite, cost.cacheRead].every(rate => Number.isFinite(rate) && rate >= 0) ||
		(cost.input === 0 && cost.output === 0)
	)
		throw new Error(`Unknown billable model price; refusing request: ${values.model}`);
	const usdReserves = reserves.map(
		tokens =>
			((tokens - outputCap) * Math.max(cost.input, cost.cacheWrite, cost.cacheRead) + outputCap * cost.output) /
			1_000_000,
	);
	const preflightUsd = usdReserves.reduce((a, b) => a + b, 0);
	if (budget.reservedUsd + preflightUsd > maxUsd) throw new Error("Whole-run aggregate USD budget preflight failed");
	for (let i = 0; i < requests.length; i++) {
		const { scenario, aliases, context } = requests[i];
		const sequence = await runLeadSequence(
			scenario,
			tools,
			[{ role: "user", content: context, timestamp: 0 }],
			async messages => {
				const tokens = Buffer.byteLength(JSON.stringify(messages)) + toolBytes + outputCap + 4096;
				const usd =
					((tokens - outputCap) * Math.max(cost.input, cost.cacheWrite, cost.cacheRead) +
						outputCap * cost.output) /
					1_000_000;
				if (
					budget.calls + 1 > maxCalls ||
					budget.reservedTokens + tokens > maxTokens ||
					budget.reservedUsd + usd > maxUsd
				)
					throw new Error("Aggregate budget exhausted before continuation; no request sent");
				budget.calls++;
				budget.reservedTokens += tokens;
				budget.reservedUsd += usd;
				await Bun.write(values["budget-file"], JSON.stringify(budget, null, 2));
				return stream(
					{ ...model, cost },
					{ messages, tools },
					{
						apiKey: credentials.apiKey,
						headers: credentials.headers,
						maxTokens: outputCap,
						maxHttpAttempts: 1,
						signal: AbortSignal.timeout(90000),
					},
				).result();
			},
		);
		const response = sequence.responses[sequence.responses.length - 1];
		const first = sequence.terminalCall ?? sequence.calls[0];
		const passes = (expected: Scenario["expected"]) =>
			!sequence.failure &&
			response.stopReason !== "error" &&
			response.stopReason !== "aborted" &&
			(expected === null
				? sequence.terminalCall?.name === "wait" || response.content.every(b => b.type !== "toolCall")
				: expected.tool === "text"
					? response.content.every(b => b.type !== "toolCall") &&
						response.content.some(
							b =>
								b.type === "text" &&
								("reviewPage" in expected!.args || b.text.includes("?")) &&
								Object.values(expected!.args).every(value =>
									b.text.toLowerCase().includes(String(value).toLowerCase()),
								),
						)
					: first?.name === expected.tool && contains(first.arguments, expected.args, first.name === "task"));
		const calls = sequence.calls;
		const roundTrip =
			!scenario.id.startsWith("estimate-cap") && "phases" in scenario
				? await verifyLeadRoundTrip(scenario as LeadInstructionScenario, calls)
				: true;
		const repeatsQuestion =
			"expectedReview" in scenario &&
			scenario.expectedReview &&
			response.content.some(b => b.type === "text" && b.text.includes("?"));
		const schemaValid = calls.every(call => {
			try {
				validateToolCall(tools, call);
				return true;
			} catch {
				return false;
			}
		});
		const pass = passes(scenario.expected) && roundTrip && !repeatsQuestion && schemaValid;
		const result: Result = {
			id: scenario.id,
			pass,
			expected: scenario.expected,
			firstToolCall: calls[0],
			toolCalls: calls,
			failure: sequence.failure,
			stopReason: response.stopReason,
			usage: sequence.responses.map(r => r.usage),
			error: response.errorMessage,
			context,
			responseText: sequence.responses
				.flatMap(r => r.content)
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n"),
			contextHash: new Bun.CryptoHasher("sha256").update(context).digest("hex"),
		};
		results.push(
			result,
			...(await Promise.all(
				aliases.map(async alias => ({
					...result,
					id: alias.id,
					expected: alias.expected,
					pass:
						passes(alias.expected) &&
						("phases" in alias ? await verifyLeadRoundTrip(alias as LeadInstructionScenario, calls) : true) &&
						!repeatsQuestion &&
						schemaValid,
					aliasOf: scenario.id,
				})),
			)),
		);
		await Bun.write(
			values.output,
			JSON.stringify(
				{
					model: values.model,
					api: model.api,
					pricingSource: pricingSelector ?? values.model,
					cost,
					schemaSource: values["tool-schemas"],
					schemaHash: schemaText ? new Bun.CryptoHasher("sha256").update(schemaText).digest("hex") : undefined,
					asOf: new Date().toISOString(),
					budget,
					results,
				},
				null,
				2,
			),
		);
		console.log(`${pass ? "PASS" : "FAIL"}\t${scenario.id}\t${first?.name ?? "no call"}`);
		for (const alias of aliases)
			console.log(
				`${results.find(r => r.id === alias.id)?.pass ? "PASS" : "FAIL"}\t${alias.id}\talias of ${scenario.id}`,
			);
		if (
			sequence.failure?.startsWith("Provider request stopped:") ||
			response.stopReason === "error" ||
			response.stopReason === "aborted"
		)
			throw new Error(`Provider stopped at ${scenario.id}; no retries or fallback. Receipt saved.`);
	}
} finally {
	auth?.close();
	await fs.rm(dir, { recursive: true, force: true });
}
if (results.some(r => !r.pass)) process.exitCode = 1;
