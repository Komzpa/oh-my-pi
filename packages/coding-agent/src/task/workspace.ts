import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import type { TaskWorkspace, VerifiedTaskWorkspace } from "@oh-my-pi/pi-tui/tools/task";
import type { SessionManager } from "../session/session-manager";
import { ensureIsolation, getRepoRoot } from "./worktree";
import { nativeWorkspace, type IsolationWorkspace, type OpenWorkspace } from "./isolation-runner";
import workspaceTemplate from "./workspace.md" with { type: "text" };

export type { TaskWorkspace, VerifiedTaskWorkspace } from "@oh-my-pi/pi-tui/tools/task";

const preparedIsolations = new Map<string, IsolationWorkspace>();

export function preparedTaskIsolation(cwd: string): IsolationWorkspace {
	const handle = preparedIsolations.get(cwd);
	if (!handle)
		throw new Error(
			`workspace.path: prepared checkout ${cwd} is unavailable. Remedy: use task with workspace.repo and workspace.base to prepare it again.`,
		);
	preparedIsolations.delete(cwd);
	return handle;
}

export async function discardPreparedTaskWorkspace(record: VerifiedTaskWorkspace): Promise<void> {
	const handle = preparedIsolations.get(record.cwd);
	if (!handle) return;
	preparedIsolations.delete(record.cwd);
	await handle.cleanup();
}

function refusal(field: string, expected: string, actual: unknown, remedy: string): never {
	throw new Error(
		`${field}: expected ${expected}; actual ${JSON.stringify(actual)}. Remedy: use bash to run ${remedy}.`,
	);
}

async function absoluteExisting(value: string, field: string): Promise<string> {
	if (typeof value !== "string" || !path.isAbsolute(value))
		refusal(field, "an absolute existing path", value, "pwd and supply an absolute path");
	try {
		return await fs.realpath(value);
	} catch {
		return refusal(field, "an existing path", value, `stat -- ${JSON.stringify(value)} and supply an existing path`);
	}
}

/** Prepare once before admission; no task text participates in repository or rights selection. */
export async function prepareTaskWorkspace(input: {
	workspace?: TaskWorkspace;
	reads?: string[];
	resources?: string[];
	cwd: string;
	id: string;
	isolated?: boolean;
	openWorkspace?: OpenWorkspace;
}): Promise<VerifiedTaskWorkspace> {
	const reads: string[] = [];
	if (input.reads !== undefined && !Array.isArray(input.reads))
		refusal("reads", "an array of absolute existing paths", input.reads, "pwd and supply reads as an array");
	for (const entry of input.reads ?? []) reads.push(await absoluteExisting(entry, "reads"));
	let cwd = await absoluteExisting(input.cwd, "cwd");
	let repo = cwd;
	let head = "";
	if (input.workspace !== undefined) {
		const workspace = input.workspace;
		if (!workspace || typeof workspace !== "object")
			refusal(
				"workspace",
				"{repo, base, path?}",
				workspace,
				"git rev-parse HEAD and supply workspace.repo and workspace.base",
			);
		const source = await absoluteExisting(workspace.repo, "workspace.repo");
		const sourceInfo = vcs.gitInfo(source);
		if (!sourceInfo)
			refusal(
				"workspace.repo",
				"an existing Git repository",
				source,
				`git -C ${JSON.stringify(source)} status and supply a Git checkout`,
			);
		repo = await getRepoRoot(source);
		if (typeof workspace.base !== "string" || !workspace.base.trim())
			refusal(
				"workspace.base",
				"a commit in workspace.repo",
				workspace.base,
				`git -C ${JSON.stringify(repo)} rev-parse HEAD`,
			);
		const resolved = await vcs
			.requireGit(repo)
			.resolveRef(`${workspace.base}^{commit}`)
			.catch(() => undefined);
		if (!resolved)
			refusal(
				"workspace.base",
				`a commit available in ${repo}`,
				workspace.base,
				`git -C ${JSON.stringify(repo)} fetch origin ${JSON.stringify(workspace.base)}`,
			);
		head = resolved;
		if (workspace.path !== undefined) {
			cwd = await absoluteExisting(workspace.path, "workspace.path");
			const actual = vcs.gitInfo(cwd);
			const expected = vcs.requireGit(repo).info();
			if (!actual || (await fs.realpath(actual.commonDir)) !== (await fs.realpath(expected.commonDir)))
				refusal(
					"workspace.path",
					`a checkout of ${repo}`,
					cwd,
					`git -C ${JSON.stringify(repo)} worktree add --detach <new-absolute-path> ${head}`,
				);
			const actualHead = await vcs.requireGit(cwd).headSha();
			if (actualHead !== head)
				refusal(
					"workspace.path HEAD",
					head,
					actualHead,
					`git -C ${JSON.stringify(repo)} worktree add --detach <new-absolute-path> ${head}`,
				);
		} else {
			const handle = await ensureIsolation(repo, input.id, undefined, head);
			const workspace = await nativeWorkspace(undefined, handle)(repo, input.id);
			cwd = workspace.dir;
			preparedIsolations.set(cwd, workspace);
		}
	} else {
		const git = vcs.git(cwd);
		if (git) {
			repo = git.info().repoRoot;
			head = (await git.headSha()) ?? "";
		}
		if (input.isolated === true) {
			repo = await getRepoRoot(cwd);
			const workspace = await (input.openWorkspace ?? nativeWorkspace(undefined))(repo, input.id);
			cwd = workspace.dir;
			preparedIsolations.set(cwd, workspace);
		}
	}
	return { repo, cwd, head, reads, resources: input.resources ?? [cwd] };
}

/** The recorded SHA is immutable across warm/cold reentry, including a changed checkout. */
export async function validateTaskWorkspace(record: VerifiedTaskWorkspace): Promise<void> {
	await absoluteExisting(record.cwd, "workspace.path");
	for (const entry of record.reads) await absoluteExisting(entry, "reads");
	if (record.head) {
		const actual = await vcs.git(record.cwd)?.headSha();
		if (actual !== record.head)
			refusal(
				"workspace.path HEAD",
				record.head,
				actual,
				`git -C ${JSON.stringify(record.repo)} worktree add --detach <new-absolute-path> ${record.head}`,
			);
	}
}

export function renderTaskWorkspace(record: VerifiedTaskWorkspace): string {
	return prompt.render(workspaceTemplate, { record: JSON.stringify(record) });
}

export async function persistTaskWorkspace(sessionFile: string, record: VerifiedTaskWorkspace): Promise<void> {
	const commonDir = vcs.gitInfo(record.cwd)?.commonDir;
	await Bun.write(`${sessionFile}.workspace.json`, JSON.stringify({ workspace: record, commonDir }));
}

export async function readTaskWorkspace(
	sessionFile: string | null | undefined,
): Promise<VerifiedTaskWorkspace | undefined> {
	if (!sessionFile) return undefined;
	let saved: { workspace: VerifiedTaskWorkspace; commonDir?: string };
	try {
		saved = await Bun.file(`${sessionFile}.workspace.json`).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const record = saved.workspace;
	const actualCommonDir = vcs.gitInfo(record.cwd)?.commonDir;
	if (saved.commonDir !== actualCommonDir)
		refusal(
			"workspace.repo",
			saved.commonDir ?? "the original checkout identity",
			actualCommonDir,
			`git -C ${JSON.stringify(record.repo)} worktree list and restore the verified checkout`,
		);
	await validateTaskWorkspace(record);
	return record;
}

export async function validatePersistedTaskWorkspace(manager: SessionManager): Promise<void> {
	const entry = manager
		.getEntries()
		.find(entry => entry.type === "custom" && entry.customType === "verified-task-workspace");
	if (!entry || entry.type !== "custom") return;
	const record = await readTaskWorkspace(manager.getSessionFile());
	if (!record)
		throw new Error(
			"workspace: expected the persisted verified workspace record; actual missing. Remedy: use task with workspace.repo and workspace.base to start a new verified worker.",
		);
	if (JSON.stringify(entry.data) !== JSON.stringify(record))
		throw new Error(
			"workspace: expected the original persisted workspace and grants; actual changed record. Remedy: use task with workspace.repo and workspace.base to start a new verified worker.",
		);
}
