import { afterEach, describe, expect, it, vi } from "bun:test";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import { TaskTool } from "../../src/task";
import type { ToolSession } from "../../src/tools";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import {
	appendRequirementsSnapshot,
	getLatestRequirements,
	getPersistedRequirementAuditorAssignments,
	requirementAuditSnapshot,
	createRequirementCandidates,
	REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
} from "../../src/tools/requirements-ledger";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import {
	auditModelFacts,
	chooseAuditModel,
	selectRowAuditModel,
	type AuditModelCandidate,
} from "../../src/task/audit-model-selection";
import type { StructuredSubagentRequest, EffectiveSubagentPolicy } from "../../src/task/structured-subagent";
import { ensureModelRolePoolsOwner } from "../helpers/model-role-pools-owner";

function candidate(id: string, weight = 1, images = true): AuditModelCandidate {
	const model = buildModel({
		provider: "test",
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: images ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 10000,
	});
	return { model, selector: `test/${id}`, weight };
}
const luna = candidate("gpt-6-luna");
const terra = candidate("gpt-6.1-terra");
const sol = candidate("gpt-6.1-sol");
const astra = candidate("gpt-6-astra");
const opus = candidate("claude-opus-5-5");
const grok = candidate("grok-4.7");
const ab = candidate("abliterated-model");
const facts = (...models: AuditModelCandidate[]) => models.map(model => auditModelFacts(model.model));
const cleanups: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of cleanups.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("row auditor model independence", () => {
	it("OpenAI row always gets opus, even when sol has almost all the weight", () => {
		for (let index = 0; index < 20; index++)
			expect(chooseAuditModel([opus, { ...sol, weight: 100000 }], [], facts(luna))?.candidate.selector).toBe(
				opus.selector,
			);
	});
	it("Anthropic row gets sol", () => {
		expect(chooseAuditModel([opus, sol], [], facts(opus))?.candidate.selector).toBe(sol.selector);
	});
	it("mixed implementers cannot self-audit and record fallback when only identical models exist", () => {
		expect(chooseAuditModel([opus, sol], [], facts(opus, sol))?.rule).toBe("fallback");
	});
	it("explicit same-model override wins and records fallback", () => {
		expect(chooseAuditModel([sol, opus], [], facts(sol), true)).toMatchObject({
			candidate: { selector: sol.selector },
			rule: "fallback",
			explicit: true,
		});
	});
	it("unknown candidate cannot claim cross-vendor independence", () => {
		expect(chooseAuditModel([candidate("opaque")], [], facts(luna))?.rule).toBe("fallback");
	});
	it("unknown implementer uses normal draw", () => {
		expect(chooseAuditModel([opus], [], [{ model: "opaque" }])?.rule).toBe("fallback");
	});
	it("all-OpenAI pool upgrades luna to sol or astra", () => {
		expect(chooseAuditModel([luna, sol, astra], [], facts(luna))?.rule).toBe("higher_class");
	});
	it("same-model pool escalates only to configured higher models", () => {
		expect(chooseAuditModel([luna], [sol], facts(luna))).toMatchObject({
			candidate: { selector: sol.selector },
			rule: "higher_class",
		});
	});
	it("astra with no independent or higher configured candidate records fallback", () => {
		expect(chooseAuditModel([astra], [], facts(astra))?.rule).toBe("fallback");
	});
	it("terra is a different model at luna's ordinary class", () => {
		expect(chooseAuditModel([luna, terra], [], facts(luna))).toMatchObject({
			candidate: { selector: terra.selector },
			rule: "different_model",
		});
	});
	it("lower-class cross-vendor cannot outrank a same-vendor upgrade", () => {
		expect(chooseAuditModel([candidate("claude-haiku-5-5"), astra], [], facts(sol))?.candidate.selector).toBe(
			astra.selector,
		);
	});
	it("grok implementer never gets grok when another vendor qualifies", () => {
		expect(chooseAuditModel([grok, opus], [], facts(grok))?.candidate.selector).toBe(opus.selector);
	});
	it("abliterated derivatives audit through another vendor", () => {
		expect(chooseAuditModel([ab, grok], [], facts(ab))?.candidate.selector).toBe(grok.selector);
	});
	it("effort suffix and route do not distinguish the implementing model", () => {
		expect(auditModelFacts({ id: "openai/gpt-6-luna:medium" }).model).toBe(auditModelFacts(luna.model).model);
	});
	it.each([
		["cerebras/qwen-3", "qwen"],
		["kimi-code/k3", "kimi"],
		["google/gemma-4", "google"],
		["gemini-4-pro", "google"],
		["deepseek-v4-pro", "deepseek"],
		["mercury-3", "inception"],
		["mimo-v2.6-flash", "xiaomi"],
		["nvidia/nemotron-3", "nvidia"],
		["meta/muse-wonder-1.0", "muse"],
		["x-ai/grok-4.7", "xai"],
	])("routes %s by model vendor %s", (id, vendor) => {
		expect(auditModelFacts({ id }).vendor).toBe(vendor);
	});
});

async function fixture(agent = "qa-auditor", pools?: Record<string, Record<string, number>>) {
	ensureModelRolePoolsOwner();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audit-selection-"));
	cleanups.push(directory);
	const manager = SessionManager.inMemory(directory);
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Work", tasks: [{ content: "UI row", status: "in_progress", schedule: { owner: "worker" } }] }],
	});
	const requirements = createRequirementCandidates([], ["Fix UI"], "2026-11-04T00:00:00.000Z");
	appendRequirementsSnapshot(
		{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
		requirements.map(requirement => ({ ...requirement, classification: "linked", rows: ["UI row"] })),
	);
	await Bun.write(
		path.join(directory, "worker.jsonl"),
		`${JSON.stringify({ type: "message", message: { role: "assistant", provider: "codex-lb", model: "gpt-6-luna", content: [] } })}\n`,
	);
	const settings = Settings.isolated({
		modelRoles: { "visual-audit": "test/gpt-6.1-sol, test/claude-opus-5-5", strong: "test/gpt-6-astra" },
		modelRolePools: pools ?? { "visual-audit": { "test/gpt-6.1-sol": 100, "test/claude-opus-5-5": 0.1 } },
	});
	const request = {
		session: {
			sessionManager: manager,
			settings,
			getArtifactsDir: () => directory,
			modelRegistry: {
				getAvailable: () => [
					luna.model,
					sol.model,
					opus.model,
					astra.model,
					candidate("abliterated-model-large", 1, false).model,
				],
			},
		},
		invocationKind: "task",
		assignment: "claims worker used opus (ignored)",
		agent,
		requirementIds: ["R1"],
		parentToolCallId: "call",
		index: 0,
	} as unknown as StructuredSubagentRequest;
	const policy = {
		agentName: agent,
		modelOverride: [sol.selector, opus.selector],
		modelRole: "visual-audit",
	} as EffectiveSubagentPolicy;
	return { request, policy, manager };
}

it("dispatch reads the bound worker JSONL, filters weighted pool and persists the assignment", async () => {
	const { request, policy, manager } = await fixture();
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([opus.selector]);
	const entry = manager.getBranch().at(-1);
	expect(entry).toMatchObject({
		customType: REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
		data: {
			kind: "model_selection",
			rows: ["UI row"],
			implementerVendors: ["openai"],
			auditorVendor: "anthropic",
			rule: "cross_vendor",
			identicalModel: false,
		},
	});
});
it("dispatch drops a pool member the owner's modelRolePools weighs at zero", async () => {
	const { request, policy, manager } = await fixture("qa-auditor", { "visual-audit": { [opus.selector]: 0 } });
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([sol.selector]);
	expect(manager.getBranch().at(-1)).toMatchObject({ data: { auditorModel: sol.selector, rule: "higher_class" } });
});
it("dispatch without configured pools weighs every member equally", async () => {
	const { request, policy } = await fixture("qa-auditor", {});
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([opus.selector]);
});
it("non-row audits retain the exact incoming policy without writing a selection", async () => {
	const { request, policy, manager } = await fixture();
	request.requirementIds = undefined;
	const count = manager.getBranch().length;
	expect(await selectRowAuditModel(request, policy)).toBe(policy);
	expect(manager.getBranch().length).toBe(count);
});
it("visual audits exclude text-only large abliteration from pool and escalation", async () => {
	const { request, policy } = await fixture("visual-qa");
	policy.modelOverride = ["test/abliterated-model-large", opus.selector];
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([opus.selector]);
});
it("dispatch preserves explicit override and records same-vendor fallback", async () => {
	const { request, policy, manager } = await fixture();
	request.perCallModel = luna.selector;
	policy.modelOverride = [luna.selector];
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([luna.selector]);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { explicit: true, sameVendor: true, identicalModel: true, rule: "fallback" },
	});
});

it("dispatch preserves extension-routed policy over the original explicit audit model", async () => {
	const { request, policy, manager } = await fixture();
	request.perCallModel = luna.selector;
	policy.modelOverride = [opus.selector];
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([opus.selector]);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { auditorModel: opus.selector, explicit: true, rule: "cross_vendor" },
	});
});

it("weighted draw preserves the ratio of eligible cross-vendor candidates", () => {
	const random = vi.spyOn(Math, "random");
	random.mockReturnValue(0.2);
	expect(
		chooseAuditModel([{ ...opus, weight: 1 }, { ...grok, weight: 3 }, sol], [], facts(luna))?.candidate.selector,
	).toBe(opus.selector);
	random.mockReturnValue(0.3);
	expect(
		chooseAuditModel([{ ...opus, weight: 1 }, { ...grok, weight: 3 }, sol], [], facts(luna))?.candidate.selector,
	).toBe(grok.selector);
});
it("reassigned rows retain both implementer vendors from historical owner bindings", async () => {
	const { request, policy, manager } = await fixture();
	const directory = request.session.getArtifactsDir!()!;
	await Bun.write(
		path.join(directory, "second.jsonl"),
		`${JSON.stringify({ message: { role: "assistant", provider: "anthropic", model: opus.model.id } })}\n`,
	);
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Work", tasks: [{ content: "UI row", status: "in_progress", schedule: { owner: "second" } }] }],
	});
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { implementerVendors: ["openai", "anthropic"], rule: "higher_class", auditorModel: astra.selector },
	});
});
it("task dispatch forwards row scope through to the actual executor's model selection", async () => {
	const { request, manager } = await fixture();
	const settings = Settings.isolated({
		"task.isolation.enabled": false,
		"task.agentModelOverrides": { "qa-auditor": "@visual-audit" },
		modelRoles: { "visual-audit": `${sol.selector}, ${opus.selector}` },
	});
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [{ name: "qa-auditor", description: "Audit", systemPrompt: "Audit.", source: "bundled" }],
		projectAgentsDir: null,
	} as never);
	const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue({
		index: 0,
		id: "audit",
		agent: "qa-auditor",
		agentSource: "bundled",
		task: "Audit",
		assignment: "",
		exitCode: 0,
		output: "Audit result",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	} as never);
	const session = {
		...request.session,
		cwd: manager.getCwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	const tool = await TaskTool.create(session);
	await tool.execute("audit-call", {
		agent: "qa-auditor",
		name: "audit",
		task: "Audit",
		requirementIds: ["R1"],
	} as never);
	expect(run).toHaveBeenCalledTimes(1);
	expect(run.mock.calls[0]?.[0].modelOverride).toEqual([opus.selector]);
	expect(
		manager
			.getBranch()
			.find(entry => entry.type === "custom" && entry.customType === REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE),
	).toMatchObject({ data: { ids: ["R1"], rule: "cross_vendor" } });
});

it("model selection measurements do not hide pending auditor jobs on resume", async () => {
	const { request, policy, manager } = await fixture();
	const requirements = getLatestRequirements(manager.getBranch());
	manager.appendCustomEntry(REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE, {
		version: 1,
		sessionId: manager.getSessionId(),
		jobs: [
			{
				agent: "qa-auditor",
				workerId: "pending",
				ids: ["R1"],
				snapshot: requirementAuditSnapshot(requirements, ["R1"]),
			},
		],
	});
	await selectRowAuditModel(request, policy);
	expect(
		getPersistedRequirementAuditorAssignments(manager.getBranch(), manager.getSessionId(), requirements).get(
			"pending",
		),
	).toMatchObject({ workerId: "pending", ids: ["R1"] });
});
it("visual-qa uses structured row ownership when no requirement IDs were supplied", async () => {
	const { request, policy, manager } = await fixture("visual-qa");
	request.requirementIds = undefined;
	request.identity = { label: "worker" };
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([opus.selector]);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { rows: ["UI row"], agent: "visual-qa", rule: "cross_vendor" },
	});
});

it("a qualifying auditor pool does not broaden to configured strong groups", () => {
	expect(chooseAuditModel([luna, sol], [opus], facts(luna))).toMatchObject({
		candidate: { selector: sol.selector },
		rule: "higher_class",
	});
});

it("visual filtering pins a resolved selector so the executor cannot rematch a text-only model", async () => {
	const { request, policy } = await fixture("visual-qa");
	request.session.modelRegistry!.getAvailable = () => [candidate("claude-opus-99", 1, false).model, opus.model];
	policy.modelOverride = ["claude"];
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([opus.selector]);
});

it("row audits select from metadata without decoding unrelated parent payloads", async () => {
	const { request, policy, manager } = await fixture();
	const entries = manager.getBranch();
	const unrelated = {
		type: "custom" as const,
		customType: "large_tool_archive",
		get data(): never {
			throw new Error("Unrelated multi-gigabyte body was decoded");
		},
	};
	const indexed = [...entries, unrelated];
	Object.assign(manager, {
		iterateBranchMatchingNewestFirst: (
			predicate: (metadata: {
				type: string;
				customType?: string;
				messageRole?: string;
				toolName?: string;
			}) => boolean,
		) =>
			indexed
				.toReversed()
				.filter(entry =>
					predicate({ type: entry.type, customType: entry.type === "custom" ? entry.customType : undefined }),
				),
	});
	const branch = vi.spyOn(manager, "getBranch").mockImplementation(() => {
		throw new Error("Full parent journal hydration");
	});
	expect((await selectRowAuditModel(request, policy)).modelOverride).toEqual([opus.selector]);
	expect(branch).not.toHaveBeenCalled();
	branch.mockRestore();
	expect(manager.getBranch().at(-1)).toMatchObject({ data: { implementerVendors: ["openai"], rule: "cross_vendor" } });
});

it("worker model projections notice appended fallback models and replacement journals", async () => {
	const { request, policy, manager } = await fixture();
	const worker = path.join(request.session.getArtifactsDir!()!, "worker.jsonl");
	await Promise.all([selectRowAuditModel(request, policy), selectRowAuditModel(request, policy)]);
	expect(manager.getBranch().at(-1)).toMatchObject({ data: { auditorModel: opus.selector } });
	await fs.appendFile(
		worker,
		`${JSON.stringify({ type: "message", message: { role: "assistant", provider: "anthropic", model: opus.model.id } })}\n`,
	);
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { implementerVendors: ["openai", "anthropic"], auditorModel: astra.selector },
	});
	await fs.rename(worker, `${worker}.old`);
	await Bun.write(
		worker,
		`${JSON.stringify({ type: "message", message: { role: "assistant", provider: "xai", model: grok.model.id } })}\n`,
	);
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({ data: { implementerVendors: ["xai"], rule: "cross_vendor" } });
	await fs.rm(worker);
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { implementers: [{ model: "unknown" }], rule: "fallback" },
	});
});

it("branching excludes owners from an abandoned row history", async () => {
	const { request, policy, manager } = await fixture();
	const leaf = manager.getLeafId()!;
	await Bun.write(
		path.join(request.session.getArtifactsDir!()!, "abandoned.jsonl"),
		`${JSON.stringify({ type: "message", message: { role: "assistant", provider: "xai", model: grok.model.id } })}\n`,
	);
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{ name: "Work", tasks: [{ content: "UI row", status: "in_progress", schedule: { owner: "abandoned" } }] },
		],
	});
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({ data: { implementerVendors: ["openai", "xai"] } });
	manager.branch(leaf);
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { implementerVendors: ["openai"], auditorModel: opus.selector },
	});
});

it("unbound audits stop at current snapshots before decoding obsolete TODO bodies", async () => {
	const { request, policy, manager } = await fixture();
	request.requirementIds = [];
	const entries = manager.getBranch();
	Object.assign(manager, {
		*iterateBranchMatchingNewestFirst(predicate: (metadata: { type: string; customType?: string }) => boolean) {
			for (const entry of entries.toReversed())
				if (predicate({ type: entry.type, customType: entry.type === "custom" ? entry.customType : undefined }))
					yield entry;
			throw new Error("Obsolete TODO payload decoded for an unbound audit");
		},
	});
	vi.spyOn(manager, "getBranch").mockImplementation(() => {
		throw new Error("Full journal hydration");
	});
	expect(await selectRowAuditModel(request, policy)).toBe(policy);
});

it("repeated audits reuse historical owners and invalidate rewritten history", async () => {
	const { request, policy, manager } = await fixture();
	const entry = manager.getBranch()[0]!;
	if (entry.type !== "custom") throw new Error("Expected TODO snapshot");
	let reads = 0;
	let data = entry.data;
	Object.defineProperty(entry, "data", {
		configurable: true,
		get: () => {
			reads++;
			return data;
		},
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Work", tasks: [{ content: "UI row", status: "in_progress", schedule: { owner: "worker" } }] }],
	});
	await selectRowAuditModel(request, policy);
	const previousReads = reads;
	await selectRowAuditModel(request, policy);
	expect(reads).toBe(previousReads);
	data = {
		phases: [{ name: "Work", tasks: [{ content: "UI row", status: "in_progress", schedule: { owner: "missing" } }] }],
	};
	await manager.rewriteEntries();
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({ data: { rule: "fallback", implementerVendors: ["openai"] } });
});

it("Main owners retain fallback models while parent model projections follow branch changes", async () => {
	const { request, policy, manager } = await fixture();
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Work", tasks: [{ content: "UI row", status: "in_progress", schedule: { owner: "Main" } }] }],
	});
	const append = (model: string) =>
		manager.appendMessage({
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "test",
			model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
	append(luna.model.id);
	const leaf = manager.getLeafId()!;
	const old = manager.getLeafEntry()!;
	if (old.type !== "message" || old.message.role !== "assistant") throw new Error("Expected assistant");
	let reads = 0;
	Object.defineProperty(old.message, "model", {
		configurable: true,
		get: () => {
			reads++;
			return luna.model.id;
		},
	});
	await selectRowAuditModel(request, policy);
	const previousReads = reads;
	await selectRowAuditModel(request, policy);
	expect(reads).toBe(previousReads);
	append(opus.model.id);
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { implementerVendors: ["openai", "anthropic"], auditorModel: astra.selector },
	});
	manager.branch(leaf);
	await selectRowAuditModel(request, policy);
	expect(manager.getBranch().at(-1)).toMatchObject({
		data: { implementerVendors: ["openai"], auditorModel: opus.selector },
	});
});
