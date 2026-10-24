import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getRequirementRowArtifact, TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

const AT = "2026-10-04T12:00:00.000Z";
const LINKED_ROW = "Preserve linked work";

function createLinkedSession(cwd = "/tmp/test"): {
	tool: TodoTool;
	phases: () => TodoPhase[];
	manager: SessionManager;
} {
	const manager = SessionManager.inMemory();
	const requirements = createRequirementCandidates([], ["preserve linked work"], AT);
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements });
	let phases: TodoPhase[] = [];
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => "/tmp/test-session.json",
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		sessionManager: manager,
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
	return { tool: new TodoTool(session), phases: () => phases, manager };
}

async function linkRow(tool: TodoTool): Promise<void> {
	await tool.execute("init", { op: "init", list: [{ phase: "Work", items: [LINKED_ROW, "Unlinked neighbor"] }] });
	const result = await tool.execute("link", {
		op: "classify",
		id: "R1",
		classification: "linked",
		rows: [LINKED_ROW],
	} as never);
	if (result.isError) throw new Error("Unable to link fixture row");
}

describe("requirement-linked TODO removal guard", () => {
	it("refuses rm of a linked row and preserves it", async () => {
		const { tool, phases } = createLinkedSession();
		await linkRow(tool);

		const result = await tool.execute("rm", { op: "rm", task: LINKED_ROW });
		expect(result.isError).toBe(true);
		expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).toContain(LINKED_ROW);
	});

	it("still removes an unlinked neighboring row", async () => {
		const { tool, phases } = createLinkedSession();
		await linkRow(tool);

		const result = await tool.execute("rm", { op: "rm", task: "Unlinked neighbor" });
		expect(result.isError).toBeUndefined();
		expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).not.toContain("Unlinked neighbor");
		expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).toContain(LINKED_ROW);
	});

	it("rejects stale completed-row removal, then archives a fresh completed file receipt", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ledger-remove-"));
		try {
			const file = path.join(cwd, "artifact");
			await Bun.write(file, "audited bytes");
			const sha256 = new Bun.CryptoHasher("sha256").update("audited bytes").digest("hex");
			const { tool, phases, manager } = createLinkedSession(cwd);
			await linkRow(tool);
			const task = phases()
				.flatMap(phase => phase.tasks)
				.find(task => task.content === LINKED_ROW)!;
			Object.assign(task, { schedule: { resources: [file] } });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: phases() });
			const artifact = `R1 row "${LINKED_ROW}" @ file:${file}@sha256=${sha256}`;
			const requirements = getLatestRequirements(manager.getBranch()).map(requirement => ({
				...requirement,
				verdict: {
					status: "pass" as const,
					evidence: "observed audited bytes",
					artifact,
					workerId: "QA",
					auditor: "qa-auditor",
				},
			}));
			manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements });
			expect((await tool.execute("done", { op: "done", task: LINKED_ROW })).isError).toBeUndefined();
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: phases() });
			await Bun.write(file, "changed bytes");
			expect((await tool.execute("stale-rm", { op: "rm", task: LINKED_ROW })).isError).toBe(true);
			expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).toContain(LINKED_ROW);
			await Bun.write(file, "audited bytes");
			expect((await tool.execute("fresh-rm", { op: "rm", task: LINKED_ROW })).isError).toBeUndefined();
			expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).toEqual(["Unlinked neighbor"]);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: phases() });
			const archived = await getRequirementRowArtifact(
				{ cwd, sessionManager: manager, receipt: artifact },
				LINKED_ROW,
				phases(),
			);
			expect(archived.identityCheck?.reason).toBeUndefined();
			expect(archived.identities).toEqual([{ kind: "file", path: file, sha256 }]);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("preserves a concurrent plan edit while a completion probe is pending", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch() {
				started.resolve();
				await release.promise;
				return Response.json({ version: "v1" });
			},
		});
		try {
			const { tool, phases, manager } = createLinkedSession();
			await linkRow(tool);
			const url = `http://127.0.0.1:${server.port}/version`;
			const task = phases()
				.flatMap(phase => phase.tasks)
				.find(task => task.content === LINKED_ROW)!;
			task.deployment = `deploy:${url}@v1 field=version`;
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: phases() });
			manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
				version: 1,
				requirements: getLatestRequirements(manager.getBranch()).map(requirement => ({
					...requirement,
					verdict: {
						status: "pass",
						evidence: "observed version v1 from HTTP probe",
						artifact: `deploy:${url}@v1 field=version`,
						workerId: "QA",
						auditor: "qa-auditor",
					},
				})),
			});
			const completing = tool.execute("done", { op: "done", task: LINKED_ROW });
			await started.promise;
			const appended = await tool.execute("concurrent-append", {
				op: "append",
				phase: "Work",
				items: ["Concurrent edit"],
			});
			expect(appended.isError).toBeUndefined();
			release.resolve();
			const result = await completing;
			expect(result.isError).toBe(true);
			const text = result.content.find(item => item.type === "text")?.text ?? "";
			const firstLine = text.split("\n", 1)[0]!;
			expect(firstLine.length).toBeLessThanOrEqual(100);
			expect(firstLine).toContain(LINKED_ROW);
			expect(firstLine).toContain("Retry done");
			expect(phases().flatMap(phase => phase.tasks.map(task => [task.content, task.status]))).toEqual([
				[LINKED_ROW, "in_progress"],
				["Unlinked neighbor", "pending"],
				["Concurrent edit", "pending"],
			]);
		} finally {
			release.resolve();
			server.stop(true);
		}
	});
});
