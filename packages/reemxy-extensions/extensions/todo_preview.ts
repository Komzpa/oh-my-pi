import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TodoScheduleInput, TodoScheduleInputTask } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export const PREVIEW_ENTRY_TYPE = "todo-preview-visibility";
export interface PreviewConfig {
	enabled: boolean;
	paths: string[];
	thresholdMinutes: number;
}
export interface PreviewReason {
	kind: "deferred" | "not-applicable" | "external-blocker";
	detail: string;
	deferUntil?: number;
}
export interface PreviewRecord {
	task: string;
	commit: string;
	visibleAt?: number;
	previewPath?: string;
	reason?: PreviewReason;
}
export type PreviewAncestryProbe = (dir: string, commit: string) => Promise<boolean>;
const COMMIT = /^[0-9a-f]{40,64}$/i;

const patchCache = new Map<string, Promise<Set<string>>>();
const ancestryCache = new Map<string, boolean>();
async function measuredAncestry(dir: string, commit: string, since?: number): Promise<boolean> {
	const head = await vcs.git(dir)?.headSha();
	if (!head) return false;
	const key = `${dir}\0${head}\0${commit}\0${since}`;
	const cached = ancestryCache.get(key);
	if (cached !== undefined) return cached;
	let result = await vcs.isAncestor(dir, commit, head);
	if (!result && since !== undefined) {
		const key = `${dir}\0${head}\0${since}`;
		let patches = patchCache.get(key);
		if (!patches) {
			if (patchCache.size >= 64) patchCache.clear();
			patches = vcs.commitPatchIds(dir, head, since).then(rows => new Set(rows.map(row => row.patchId)));
			patchCache.set(key, patches);
			patches.catch(() => patchCache.delete(key));
		}
		const worker = await vcs.commitPatchIds(dir, commit, undefined, 1);
		const landed = await patches;
		result = worker.some(row => row.commit === commit && landed.has(row.patchId));
	}
	if (ancestryCache.size >= 2048) ancestryCache.clear();
	ancestryCache.set(key, result);
	return result;
}

/** Only machine identities qualify; reports and deliverable prose never do. */
export function previewCommits(row: TodoScheduleInputTask): string[] {
	const schedule = row.schedule;
	const commits = new Set<string>();
	for (const resource of schedule?.resources ?? []) {
		const match = /^git:(\/.*)@([0-9a-f]{40,64})$/i.exec(resource);
		if (match) commits.add(match[2]!);
	}
	for (const receipt of [schedule?.executor, ...(schedule?.attemptHistory ?? [])]) {
		for (const identity of receipt?.gitCommits ?? []) {
			if (COMMIT.test(identity.commit) && path.isAbsolute(identity.repoPath)) commits.add(identity.commit);
		}
	}
	return [...commits];
}

export async function refreshPreviewVisibility(
	phases: TodoScheduleInput,
	config: PreviewConfig,
	records: PreviewRecord[],
	now: number,
	isAncestor: PreviewAncestryProbe = measuredAncestry,
): Promise<PreviewRecord[]> {
	if (!config.enabled) return records;
	let next = [...records];
	const probes = new Map<string, Promise<boolean>>();
	for (const row of phases.flatMap(phase => phase.tasks)) {
		if (row.schedule?.firstRequirementAt === undefined) continue;
		// A structured git resource in the preview checkout is the lead's landed receipt.
		// It replaces the worker identities (including a squash with a different patch).
		const landed = (row.schedule.resources ?? []).flatMap(resource => {
			const match = /^git:(\/.*)@([0-9a-f]{40,64})$/i.exec(resource);
			return match && config.paths.includes(match[1]!) ? [match[2]!] : [];
		});
		const commits = landed.length
			? landed
			: [
					...previewCommits(row),
					...records.filter(record => record.task === row.content && COMMIT.test(record.commit)).map(record => record.commit),
				];
		if (commits.length) next = next.filter(record => record.task !== row.content || record.commit !== "");
		if (landed.length) next = next.filter(record => record.task !== row.content || landed.includes(record.commit));
		for (const commit of new Set(commits)) {
			let index = next.findIndex(record => record.task === row.content && record.commit === commit);
			if (index < 0) {
				index = next.length;
				next.push({ task: row.content, commit });
			}
			if (next[index]!.visibleAt !== undefined) continue;
			for (const dir of config.paths.filter(value => path.isAbsolute(value))) {
				const key = `${dir}\0${commit}\0${row.schedule.firstRequirementAt}`;
				let probe = probes.get(key);
				if (!probe) {
					probe = (
						isAncestor === measuredAncestry
							? measuredAncestry(dir, commit, row.schedule.firstRequirementAt)
							: isAncestor(dir, commit)
					).catch(() => false);
					probes.set(key, probe);
				}
				if (await probe) {
					next[index] = { ...next[index]!, visibleAt: now, previewPath: dir };
					break;
				}
			}
		}
	}
	return next;
}

/** Profiles whose work never produces a product UI change to preview: branch, CI, install, research and docs work. */
const NON_VISUAL_PROFILES = new Set([
	"rebaser",
	"git-pr-owner",
	"gate-runner",
	"install-owner",
	"researcher",
	"scribe",
	"business-analyst",
	"retro-facilitator",
	"plan-doctor",
	"profiler",
	"security-reviewer",
	"scout",
]);
const UI_FILE = /\.(?:tsx|jsx|vue|svelte|css|scss|sass|less|html?|svg|glsl|wgsl)$/i;

/**
 * Visual vs non-visual from behaviour, never the row title: a row is visual when its resources or
 * delivered artifacts touch product UI files or a configured preview checkout. A row whose executor
 * profile does branch/CI/research/docs work, or whose resources are all non-UI files, is non-visual.
 * Anything undecided stays visual, so the preview gate keeps covering it.
 */
export function visualPreviewRow(row: TodoScheduleInputTask, previewPaths: readonly string[] = []): boolean {
	const schedule = row.schedule as
		| (NonNullable<TodoScheduleInputTask["schedule"]> & { resources?: unknown[] })
		| undefined;
	const resources = (schedule?.resources ?? []).filter((item): item is string => typeof item === "string");
	const delivered = (schedule?.attemptHistory ?? []).flatMap(attempt =>
		(attempt.deliverablePaths ?? []).filter((item): item is string => typeof item === "string"),
	);
	const roots = previewPaths.map(root => path.resolve(root));
	if ([...resources, ...delivered].some(item => UI_FILE.test(item) || roots.includes(path.resolve(item)))) return true;
	const profile = schedule?.executor?.agentProfile;
	if (typeof profile === "string" && NON_VISUAL_PROFILES.has(profile)) return false;
	const files = resources.filter(item => path.extname(item) !== "");
	return !(resources.length > 0 && files.length === resources.length);
}

export function overduePreviewRows(
	phases: TodoScheduleInput,
	records: PreviewRecord[],
	config: PreviewConfig,
	now: number,
): TodoScheduleInputTask[] {
	if (!config.enabled) return [];
	return phases
		.flatMap(phase => phase.tasks)
		.filter(row => {
			if (!visualPreviewRow(row, config.paths)) return false;
			const asked = row.schedule?.firstRequirementAt ?? row.schedule?.startedAt;
			if (asked === undefined || now - asked < Math.max(0, config.thresholdMinutes) * 60_000) return false;
			const observed = records.filter(record => record.task === row.content);
			const deferred = (record: PreviewRecord) => record.reason?.kind === "deferred" &&
				typeof record.reason.deferUntil === "number" && record.reason.deferUntil > now;
			return observed.length === 0 || observed.some(record => record.visibleAt === undefined &&
				!(record.reason?.kind === "not-applicable" || record.reason?.kind === "external-blocker" || deferred(record)));
		});
}

function gateRow(row: TodoScheduleInputTask | undefined): boolean {
	return (
		row?.schedule?.executor?.agentProfile === "gate-runner" ||
		/\b(?:whole|full)[- ]suite\b|\blanding[- ]gate\b/i.test(row?.content ?? "")
	);
}

export function previewScheduleRefusal(
	input: unknown,
	phases: TodoScheduleInput,
	records: PreviewRecord[],
	profiles: Map<string, string | undefined>,
): string | undefined {
	const call = input as { op?: string; updates?: Array<{ task?: string; owner?: string; dependencies?: string[] }> };
	if (call?.op !== "schedule") return;
	const rows = phases.flatMap(phase => phase.tasks);
	const exception = previewReason(input);
	for (const update of call.updates ?? []) {
		const row = rows.find(candidate => candidate.content === update.task);
		if (
			!row ||
			row.schedule?.firstRequirementAt === undefined ||
			(previewCommits(row).length === 0 && !records.some(record => record.task === row.content)) ||
			exception?.task === row.content ||
			(records.some(record => record.task === row.content) &&
				records
					.filter(record => record.task === row.content)
					.every(record => record.visibleAt !== undefined || record.reason !== undefined))
		)
			continue;
		// Only an explicit gate assignment creates a visibility prerequisite.
		const owner = update.owner;
		const dependencies = update.dependencies ?? [];
		if (
			(owner &&
				(profiles.get(owner) === "gate-runner" ||
					rows.some(
						candidate =>
							candidate.schedule?.owner === owner && candidate.schedule.executor?.agentProfile === "gate-runner",
					))) ||
			dependencies.some(dependency =>
				rows.some(
					candidate =>
						candidate.content === dependency &&
						(gateRow(candidate) ||
							(candidate.schedule?.owner !== undefined &&
								profiles.get(candidate.schedule.owner) === "gate-runner")),
				),
			)
		) {
			return `Refusing todo schedule: refresh the preview for ${JSON.stringify(row.content)} first; let the whole-suite or landing gate batch afterwards. To defer in this same call, set previewReason={task:${JSON.stringify(row.content)},kind:"deferred",detail:<reason>}.`;
		}
	}
}

export function previewDispatchRefusal(input: unknown, rows: TodoScheduleInputTask[]): string | undefined {
	rows = rows.filter(row => !(row.schedule?.previewIdentityMissing ?? previewCommits(row).length === 0));
	if (!rows.length) return;
	const call = input as {
		tasks?: Array<{ agent?: string; task?: string; previewIntegration?: { task?: string; kind?: string } }>;
		agent?: string;
		task?: string;
		previewIntegration?: { task?: string; kind?: string };
	};
	for (const item of call?.tasks ?? [call]) {
		if (item?.agent !== "gate-runner") continue;
		const blocked = rows.filter(
			row =>
				item.task?.includes(row.content) &&
				!(
					item.previewIntegration?.task === row.content &&
					["refresh", "integration"].includes(item.previewIntegration.kind ?? "")
				),
		);
		if (blocked.length) return previewPlanProblem(blocked);
	}
}

export function previewPlanProblem(rows: TodoScheduleInputTask[]): string | undefined {
	if (!rows.length) return;
	return `Plan problem ignored: preview-not-visible. Next dispatch must refresh/integrate the preview for ${rows.map(row => `${JSON.stringify(row.content)}${(row.schedule?.previewIdentityMissing ?? previewCommits(row).length === 0) ? " (no commit identity)" : ""}`).join(", ")}. Set each task item's previewIntegration={task:<exact row>,kind:"refresh"|"integration"}, or record todo.previewReason={task,kind:"deferred"|"not-applicable"|"external-blocker",detail:<reason>}.`;
}

export function previewReason(input: unknown): { task: string; reason: PreviewReason } | undefined {
	const value = (input as { previewReason?: { task?: unknown; kind?: unknown; detail?: unknown; deferUntil?: unknown } })?.previewReason;
	if (
		!value ||
		typeof value.task !== "string" ||
		typeof value.detail !== "string" ||
		!value.detail.trim() ||
		!["deferred", "not-applicable", "external-blocker"].includes(String(value.kind))
	)
		return;
	return { task: value.task, reason: { kind: value.kind as PreviewReason["kind"], detail: value.detail.trim(), ...(typeof value.deferUntil === "number" && Number.isFinite(value.deferUntil) ? { deferUntil: value.deferUntil } : {}) } };
}
