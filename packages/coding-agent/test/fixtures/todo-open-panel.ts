import type { TodoItem, TodoPhase, TodoStatus } from "@oh-my-pi/pi-tui/tools/todo";

function tasks(prefix: string, status: TodoStatus, count: number): TodoItem[] {
	return Array.from({ length: count }, (_, index) => ({ content: `${prefix} ${index + 1}`, status }));
}

/** Reverse-priority input order makes collapsed rendering prove the global priority order. */
export const openPanelPhases: TodoPhase[] = [
	{
		name: "Queued work",
		tasks: [...tasks("Pending task", "pending", 1), ...tasks("Queued completed", "completed", 6)],
	},
	{
		name: "Needs unblock",
		tasks: [...tasks("Blocked task", "blocked", 3), ...tasks("Unblock completed", "completed", 6)],
	},
	{
		name: "Execution",
		tasks: [
			...tasks("In-progress task", "in_progress", 7),
			...tasks("Execution completed", "completed", 5),
			{ content: "Execution abandoned", status: "abandoned" },
		],
	},
];

/**
 * Main-based two-row legacy analogue of the named screenshot: with no pending or
 * in-progress task, the old active-phase fallback selects the last 5/6 phase;
 * its one blocked task plus one closed-context row produce exactly two rows.
 * The screenshot's req/forecast header is intentionally not synthesized here.
 */
export const mainTwoRowBaselinePhases: TodoPhase[] = [
	{
		name: "Earlier blocked work",
		tasks: [...tasks("Earlier blocked", "blocked", 5), ...tasks("Earlier completed", "completed", 6)],
	},
	{
		name: "More blocked work",
		tasks: [
			...tasks("More blocked", "blocked", 5),
			...tasks("More completed", "completed", 6),
			{ content: "More abandoned", status: "abandoned" },
		],
	},
	{
		name: "Retro catches deploy failures",
		tasks: [
			...tasks("Retro completed", "completed", 5),
			{ content: "Replay wave4b failure and prove retro mechanism", status: "blocked" },
		],
	},
];

export const mainBaselineOpenIdentities = [
	"Earlier blocked 1",
	"Earlier blocked 2",
	"Earlier blocked 3",
	"Earlier blocked 4",
	"Earlier blocked 5",
	"More blocked 1",
	"More blocked 2",
	"More blocked 3",
	"More blocked 4",
	"More blocked 5",
	"Replay wave4b failure and prove retro mechanism",
] as const;

export const openTaskIdentities = [
	"In-progress task 1",
	"In-progress task 2",
	"In-progress task 3",
	"In-progress task 4",
	"In-progress task 5",
	"In-progress task 6",
	"In-progress task 7",
	"Blocked task 1",
	"Blocked task 2",
	"Blocked task 3",
	"Pending task 1",
] as const;
