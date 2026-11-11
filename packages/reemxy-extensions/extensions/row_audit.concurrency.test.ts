import { afterEach, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	checkRowAudits,
	resetRowAuditsForTest,
	ROW_AUDIT_CAP,
	type RowAuditOptions,
	type RowAuditRow,
} from "./row_audit";

const head = "a1".repeat(20);
const tick = () => Bun.sleep(5);
function row(id: string): RowAuditRow {
	return {
		content: `Audit ${id}`,
		status: "in_progress",
		schedule: {
			resources: [`git:/fixture/${id}@${head}`],
			executor: { workerId: `Producer-${id}`, startedAt: 1, finishedAt: 2, outcome: "completed" },
		},
	};
}
const unsettled: Array<() => void> = [];
afterEach(async () => {
	for (const settle of unsettled.splice(0)) settle();
	await tick();
	resetRowAuditsForTest();
});

function harness() {
	resetRowAuditsForTest();
	let rows = Array.from({ length: ROW_AUDIT_CAP - 1 }, (_, i) => row(`seed${i}`));
	const launches: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = [];
	const ctx = {
		cwd: "/fixture",
		sessionManager: { getBranch: () => [], getHeader: () => ({ id: "audit-capacity" }) },
		getTodoPhases: () => [{ name: "Audits", tasks: rows }],
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		updateTodoSchedule: (title: string, patch: object) => {
			const current = rows.find(item => item.content === title);
			if (!current) return false;
			Object.assign(current.schedule!, patch);
			return true;
		},
		runRowAudit: () => {
			const result = Promise.withResolvers<unknown>();
			launches.push(result);
			unsettled.push(() => result.resolve({ details: { results: [{ aborted: true }] } }));
			return result.promise;
		},
	} as unknown as ExtensionContext;
	const options: RowAuditOptions = { readHead: async () => head, resolveAuditor: async () => "qa-auditor" };
	return {
		ctx,
		options,
		launches,
		rows: () => rows,
		replace: (next: RowAuditRow[]) => {
			rows = next;
		},
	};
}

test("last audit slot is reserved before target lookup; repeated ticks cannot steal it", async () => {
	const h = harness();
	expect(await checkRowAudits(h.ctx, h.options)).toBe(ROW_AUDIT_CAP - 1);
	const entered = Promise.withResolvers<void>();
	const target = Promise.withResolvers<{}>();
	unsettled.push(() => target.resolve({}));
	let competingTargetReads = 0;
	h.options.readTarget = async repo => {
		if (repo === "/fixture/A") {
			entered.resolve();
			return target.promise;
		}
		competingTargetReads++;
		return {};
	};
	h.rows().push(row("A"));
	const first = checkRowAudits(h.ctx, h.options);
	await entered.promise;
	h.rows().unshift(row("B"));
	expect(await checkRowAudits(h.ctx, h.options)).toBe(0);
	expect(await checkRowAudits(h.ctx, h.options)).toBe(0);
	expect(competingTargetReads).toBe(0);
	target.resolve({});
	expect(await first).toBe(1);
	expect(h.launches).toHaveLength(ROW_AUDIT_CAP);
	h.launches[0]!.resolve({ details: { results: [{ aborted: true }] } });
	await tick();
	expect(await checkRowAudits(h.ctx, h.options)).toBe(1);
	expect(h.launches).toHaveLength(ROW_AUDIT_CAP + 1);
});

test("failed target lookup releases the slot and row reservation", async () => {
	const h = harness();
	await checkRowAudits(h.ctx, h.options);
	h.rows().push(row("A"));
	h.options.readTarget = async () => {
		throw new Error("target lookup failed");
	};
	await expect(checkRowAudits(h.ctx, h.options)).rejects.toThrow("target lookup failed");
	h.options.readTarget = async () => ({});
	expect(await checkRowAudits(h.ctx, h.options)).toBe(1);
	expect(h.launches).toHaveLength(ROW_AUDIT_CAP);
});

for (const outcome of ["completed", "aborted", "failed"] as const) {
	test(`${outcome} worker releases its reserved slot for another row`, async () => {
		const h = harness();
		await checkRowAudits(h.ctx, h.options);
		h.rows().push(row("A"));
		await checkRowAudits(h.ctx, h.options);
		expect(h.launches).toHaveLength(ROW_AUDIT_CAP);
		if (outcome === "failed") h.launches[0]!.reject(new Error("worker launch failed"));
		else
			h.launches[0]!.resolve({
				details: {
					results:
						outcome === "aborted"
							? [{ aborted: true }]
							: [
									{
										output: {
											rows: [
												{
													row: "Audit seed0",
													verdict: "pass",
													findings: "checked",
													checks: [{ command: "bun test", exitCode: 0 }],
												},
											],
										},
									},
								],
				},
			});
		await tick();
		h.rows().push(row("B"));
		expect(await checkRowAudits(h.ctx, h.options)).toBe(1);
		expect(h.launches).toHaveLength(ROW_AUDIT_CAP + 1);
	});
}

test("rebind during target lookup releases the slot without launching a stale audit", async () => {
	const h = harness();
	await checkRowAudits(h.ctx, h.options);
	const entered = Promise.withResolvers<void>();
	const target = Promise.withResolvers<{}>();
	unsettled.push(() => target.resolve({}));
	h.options.readTarget = async () => {
		entered.resolve();
		return target.promise;
	};
	h.rows().push(row("A"));
	const launch = checkRowAudits(h.ctx, h.options);
	await entered.promise;
	h.rows().at(-1)!.schedule!.resources = [];
	target.resolve({});
	expect(await launch).toBe(0);
	h.options.readTarget = async () => ({});
	h.replace([...h.rows().slice(0, -1), row("B")]);
	expect(await checkRowAudits(h.ctx, h.options)).toBe(1);
});

test("criterion mutation during target lookup cannot launch the old input snapshot", async () => {
	const h = harness();
	await checkRowAudits(h.ctx, h.options);
	const delivered = row("A");
	delivered.schedule!.materialInputs = { criterion: "criterion:v1", receipts: [], prerequisites: [] };
	h.rows().push(delivered);
	const entered = Promise.withResolvers<void>();
	const target = Promise.withResolvers<{}>();
	unsettled.push(() => target.resolve({}));
	h.options.readTarget = async () => {
		entered.resolve();
		return target.promise;
	};
	const launch = checkRowAudits(h.ctx, h.options);
	await entered.promise;
	delivered.schedule!.materialInputs!.criterion = "criterion:v2";
	target.resolve({});
	expect(await launch).toBe(0);
	expect(h.launches).toHaveLength(ROW_AUDIT_CAP - 1);
	h.options.readTarget = async () => ({});
	expect(await checkRowAudits(h.ctx, h.options)).toBe(1);
	expect(delivered.schedule!.audit!.materialInputs!.criterion).toBe("criterion:v2");
});
