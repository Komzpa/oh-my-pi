/** Read-only replay: bun scripts/replay-requirement-backlog.ts LEDGER SESSION CWD */
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import type { SessionEntry } from "../src/session/session-entries";
import { evaluateRequirementDoneGate, parseRequirementsLedger } from "../src/tools/requirements-ledger";
import {
	getAcceptedTodoRows,
	getRequirementRowArtifact,
	observeLatestTodoPhases,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../src/tools/todo";

const [ledgerPath, sessionPath, cwd] = process.argv.slice(2);
if (!ledgerPath || !sessionPath || !cwd) throw new Error("Expected LEDGER SESSION CWD");
const ledger = await Bun.file(ledgerPath).json();
const requirements = parseRequirementsLedger(ledger.data)?.requirements;
if (!requirements) throw new Error("Invalid requirements ledger");
const entries: SessionEntry[] = [];
const decoder = new TextDecoder();
for await (const bytes of readLines(Bun.file(sessionPath).stream())) {
	const line = decoder.decode(bytes);
	if (!line.includes('"phases"')) continue;
	const entry = JSON.parse(line) as SessionEntry;
	if (entry.timestamp > ledger.timestamp) continue;
	if (
		(entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) ||
		(entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo")
	)
		entries.push(entry);
}
const tasks = new Map<string, TodoItem>();
observeLatestTodoPhases(entries, phases => {
	for (const task of phases.flatMap(phase => phase.tasks)) tasks.set(task.content, task);
});
const phases: TodoPhase[] = [{ name: "Historical rows", tasks: [...tasks.values()] }];
const accepted = getAcceptedTodoRows(entries);
const rows = [...new Set(requirements.filter(r => r.classification === "linked").flatMap(r => r.rows))];
const rowGateBefore = requirements.filter(
	r =>
		r.classification === "candidate" ||
		(r.classification === "linked" && r.rows.some(row => r.rowVerdicts?.[row]?.status !== "pass")),
);
// The saved summary counts a requirement with any pass as passed unless it has a fail.
// Keep that supplied baseline distinct from all-linked-row gate coverage.
const before = requirements.filter(r => {
	if (r.classification !== "linked" && r.classification !== "candidate") return false;
	const verdicts = Object.values(r.rowVerdicts ?? {});
	return verdicts.some(v => v.status === "fail") || !verdicts.some(v => v.status === "pass");
});
const cache = new Map();
const gitStatusSnapshots = new Map();
const open = await evaluateRequirementDoneGate(
	requirements,
	rows,
	(row, receipt) => getRequirementRowArtifact({ cwd, receipt, gitStatusSnapshots }, row, phases, cache),
	new Map(),
	new Set(),
	new Set([...tasks.values()].filter(t => t.status !== "abandoned").map(t => t.content)),
	accepted,
);
const ids = new Set(open.map(r => r.requirement.id));
const settled = before
	.filter(r => !ids.has(r.id))
	.map(r => ({ id: r.id, reason: r.rows.every(row => accepted.has(row)) ? "accepted" : "relevant-pass" }));
const reopened = open.filter(r => !before.some(item => item.id === r.requirement.id)).map(r => r.requirement.id);
console.log(
	JSON.stringify(
		{
			asOf: ledger.timestamp,
			before: before.length,
			rowGateBefore: rowGateBefore.length,
			after: open.length,
			settled,
			reopened,
			remaining: open.map(r => ({ id: r.requirement.id, issues: r.issues })),
		},
		null,
		2,
	),
);
