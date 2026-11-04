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

const ancestryCache = new Map<string, boolean>();
async function measuredAncestry(dir: string, commit: string): Promise<boolean> {
	const head = await vcs.git(dir)?.headSha();
	if (!head) return false;
	const key = `${dir}\0${head}\0${commit}`;
	const cached = ancestryCache.get(key);
	if (cached !== undefined) return cached;
	const result = await vcs.isAncestor(dir, commit, head);
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
	const next = [...records];
	const probes = new Map<string, Promise<boolean>>();
	for (const row of phases.flatMap(phase => phase.tasks)) {
		if (row.schedule?.firstRequirementAt === undefined) continue;
		for (const commit of new Set([
			...previewCommits(row),
			...records.filter(record => record.task === row.content).map(record => record.commit),
		])) {
			let index = next.findIndex(record => record.task === row.content && record.commit === commit);
			if (index < 0) {
				index = next.length;
				next.push({ task: row.content, commit });
			}
			if (next[index]!.visibleAt !== undefined) continue;
			for (const dir of config.paths.filter(value => path.isAbsolute(value))) {
				const key = `${dir}\0${commit}`;
				let probe = probes.get(key);
				if (!probe) {
					probe = isAncestor(dir, commit).catch(() => false);
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
			const asked = row.schedule?.firstRequirementAt;
			if (asked === undefined || now - asked < Math.max(0, config.thresholdMinutes) * 60_000) return false;
			const observed = records.filter(record => record.task === row.content);
			return (
				observed.length > 0 &&
				!observed.some(record => record.visibleAt !== undefined) &&
				observed.some(record => !record.reason)
			);
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
	for (const update of call.updates ?? []) {
		const row = rows.find(candidate => candidate.content === update.task);
		if (
			!row ||
			row.schedule?.firstRequirementAt === undefined ||
			records.some(record => record.task === row.content && record.visibleAt !== undefined)
		)
			continue;
		const owner = update.owner ?? row.schedule?.owner;
		const dependencies = update.dependencies ?? row.schedule?.dependencies ?? [];
		if (
			(owner &&
				(profiles.get(owner) === "gate-runner" ||
					rows.some(candidate => candidate.schedule?.owner === owner && gateRow(candidate)))) ||
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
			return `Refusing todo schedule: refresh the preview for ${JSON.stringify(row.content)} first; let the whole-suite or landing gate batch afterwards.`;
		}
	}
}

export function previewDispatchRefusal(input: unknown, rows: TodoScheduleInputTask[]): string | undefined {
	if (!rows.length) return;
	const call = input as {
		tasks?: Array<{ previewIntegration?: { task?: string; kind?: string } }>;
		previewIntegration?: { task?: string; kind?: string };
	};
	const items = call?.tasks ?? (call?.previewIntegration ? [call] : []);
	if (
		items.length &&
		items.every(item =>
			rows.some(
				row =>
					item.previewIntegration?.task === row.content &&
					["refresh", "integration"].includes(item.previewIntegration.kind ?? ""),
			),
		)
	)
		return;
	return `Plan problem ignored: preview-not-visible. Next dispatch must refresh/integrate the preview for ${rows.map(row => JSON.stringify(row.content)).join(", ")}. Set each task item's previewIntegration={task:<exact row>,kind:"refresh"|"integration"}, or record todo.previewReason={task,kind:"deferred"|"not-applicable"|"external-blocker",detail:<reason>}.`;
}

export function previewReason(input: unknown): { task: string; reason: PreviewReason } | undefined {
	const value = (input as { previewReason?: { task?: unknown; kind?: unknown; detail?: unknown } })?.previewReason;
	if (
		!value ||
		typeof value.task !== "string" ||
		typeof value.detail !== "string" ||
		!value.detail.trim() ||
		!["deferred", "not-applicable", "external-blocker"].includes(String(value.kind))
	)
		return;
	return { task: value.task, reason: { kind: value.kind as PreviewReason["kind"], detail: value.detail.trim() } };
}
