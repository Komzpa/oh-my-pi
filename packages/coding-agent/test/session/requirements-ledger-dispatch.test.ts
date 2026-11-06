import { describe, expect, it } from "bun:test";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	createRequirementCandidates,
	getLatestRequirements,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";

// Sunbim session 01a15830, 2026-10-22 13:40Z: an impatient owner's messages became R48-R53.
const MESSAGES = [
	"где бляяяядь",
	"ХУЛИ ТАК ДОЛГО МРАЗЬ",
	"разгоняй свою ебалайку",
	"- [ ] preview the datacenter graph",
	">>>>> Since speed matters here, I should wait for the worker's result before proceeding.",
	"make the preview wider",
];

function ledger(count: number): RequirementLedgerItem[] {
	// Force all candidates to stay candidates: fixture texts bypass the capture-time heuristic.
	const base = createRequirementCandidates(
		[],
		MESSAGES.slice(0, count).map((_, i) => `owner message ${i}`),
	);
	return base.map((item, i) => ({ ...item, id: `R${48 + i}` }));
}

function apply(
	requirements: RequirementLedgerItem[],
	id: string,
	...args: Parameters<typeof classifyRequirement> extends [unknown, unknown, ...infer R] ? R : never
) {
	const result = classifyRequirement(requirements, id, ...args);
	if ("error" in result) throw new Error(result.error);
	return result.requirements;
}

const byId = (requirements: RequirementLedgerItem[], id: string) => requirements.find(r => r.id === id)!;

describe("batched classify is order independent", () => {
	const notReq = { reason: "pure urgency" };
	const merge = (id: string) => ({ mergeInto: "R48", reason: `${id} repeats R48` });

	it("merges after R48 became not-a-requirement inherit it instead of failing", () => {
		let reqs = ledger(6);
		reqs = apply(reqs, "R48", "not-a-requirement", notReq);
		for (const id of ["R49", "R50", "R51", "R52"]) reqs = apply(reqs, id, "merged", merge(id));
		for (const id of ["R48", "R49", "R50", "R51", "R52"])
			expect(byId(reqs, id).classification).toBe("not-a-requirement");
		expect(byId(reqs, "R49").reason).toContain("R48");
		expect(byId(reqs, "R53").classification).toBe("candidate");
	});

	it("merges applied before R48 is classified converge to the same ledger", () => {
		let reqs = ledger(6);
		for (const id of ["R49", "R50", "R51", "R52"]) reqs = apply(reqs, id, "merged", merge(id));
		reqs = apply(reqs, "R48", "not-a-requirement", notReq);
		for (const id of ["R48", "R49", "R50", "R51", "R52"])
			expect(byId(reqs, id).classification).toBe("not-a-requirement");
	});

	it("a merge into an already merged target follows the link to the active requirement", () => {
		let reqs = ledger(4);
		reqs = apply(reqs, "R48", "linked", { rows: ["Preview graph"] });
		reqs = apply(reqs, "R49", "merged", { mergeInto: "R48" });
		reqs = apply(reqs, "R50", "merged", { mergeInto: "R49" });
		expect(byId(reqs, "R50")).toMatchObject({ classification: "merged", mergeInto: "R48" });
	});

	it("merges applied before the target is merged elsewhere are repointed", () => {
		let reqs = ledger(4);
		reqs = apply(reqs, "R48", "linked", { rows: ["Preview graph"] });
		reqs = apply(reqs, "R50", "merged", { mergeInto: "R49" });
		reqs = apply(reqs, "R49", "merged", { mergeInto: "R48" });
		expect(byId(reqs, "R50")).toMatchObject({ classification: "merged", mergeInto: "R48" });
	});

	it("negative control: a merge into itself or an unknown target is still refused", () => {
		const reqs = ledger(3);
		expect("error" in classifyRequirement(reqs, "R49", "merged", { mergeInto: "R49" })).toBe(true);
		expect("error" in classifyRequirement(reqs, "R49", "merged", { mergeInto: "R99" })).toBe(true);
	});
});

describe("capture-time heuristic", () => {
	it("auto-classifies quoted assistant text and pure urgency, keeps real asks as candidates", () => {
		const classes = MESSAGES.map(text => createRequirementCandidates([], [text])[0]!.classification);
		expect(classes).toEqual([
			"not-a-requirement",
			"not-a-requirement",
			"candidate",
			"candidate",
			"not-a-requirement",
			"candidate",
		]);
	});
});

describe("pending candidates do not block dispatch", () => {
	function session() {
		const manager = SessionManager.inMemory();
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => "/",
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: () => {},
		});
		return { manager, runtime };
	}

	it("replays R48-R53: task is not blocked by pending R53, which is listed as a reminder", () => {
		const { manager, runtime } = session();
		const sink = { appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data) };
		appendRequirementsSnapshot(sink as never, ledger(6));
		let reqs = getLatestRequirements(manager.getBranch());
		reqs = apply(reqs, "R48", "not-a-requirement", { reason: "pure urgency" });
		for (const id of ["R49", "R50", "R51", "R52"]) reqs = apply(reqs, id, "merged", { mergeInto: "R48" });
		appendRequirementsSnapshot(sink as never, reqs);
		const result = runtime.remindUnclassifiedCandidates("task", { tasks: [{ task: "render the preview" }] });
		expect(result?.block).toBeUndefined();
		expect(result?.additionalContext).toContain("R53");
		expect(result?.additionalContext).not.toContain("R49");
	});
});
