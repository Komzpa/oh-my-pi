import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetYieldTurnState, YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";

import * as launchServices from "../../src/launch/services";
import * as launchClient from "../../src/launch/client";

afterEach(() => vi.restoreAllMocks());

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("YieldTool terminal result latch", () => {
	it("keeps the first accepted terminal result and rejects later terminal yields (642/665)", async () => {
		const tool = new YieldTool(createSession());
		const first = await tool.execute("call-first", { data: { answer: 42 } } as never);
		expect(first.details).toMatchObject({ status: "success", data: { answer: 42 } });

		await expect(tool.execute("call-second", { data: { answer: 0 } } as never)).rejects.toThrow(
			"result was already submitted",
		);
		await expect(tool.execute("call-third", { error: "retract" } as never)).rejects.toThrow("Stop now");
		expect(first.details?.data).toEqual({ answer: 42 });

		// A new monitored run (follow-up turn, IRC wake) re-arms the latch: its
		// first terminal result is accepted, then it is one-shot again.
		resetYieldTurnState(tool);
		const nextRun = await tool.execute("call-next-run", { data: { answer: 1 } } as never);
		expect(nextRun.details).toMatchObject({ status: "success", data: { answer: 1 } });
		await expect(tool.execute("call-next-run-later", { data: { answer: 2 } } as never)).rejects.toThrow(
			"result was already submitted",
		);
	});

	it("treats errors carrying incremental labels as one-shot terminal failures", async () => {
		const failed = new YieldTool(createSession());
		const result = await failed.execute("typed-error", { type: ["notes"], error: "unavailable" });
		expect(result.details?.status).toBe("aborted");
		await expect(failed.execute("late-success", { data: "replacement" })).rejects.toThrow("already submitted");
		const succeeded = new YieldTool(createSession());
		await succeeded.execute("success", { data: "answer" });
		await expect(succeeded.execute("late-error", { type: ["notes"], error: "retract" })).rejects.toThrow(
			"already submitted",
		);
	});

	it("does not release a sibling terminal claim when a concurrent section is rejected", async () => {
		const tool = new YieldTool(createSession());
		const settleSection = tool.deferResultAcceptance("section");
		const section = tool.execute("section", { type: ["notes"], data: "draft" });
		const terminal = tool.execute("terminal", { data: "retained" });
		const sectionResult = await section;
		settleSection({ ...sectionResult, isError: true });
		const terminalResult = await terminal;
		expect(terminalResult.details?.data).toBe("retained");
		await expect(tool.execute("replacement", { data: "changed" })).rejects.toThrow("already submitted");
	});

	it("allows a terminal retry after aborting its wait for an incremental wrapper", async () => {
		const tool = new YieldTool(createSession());
		const acceptSection = tool.deferResultAcceptance("section");
		const section = await tool.execute("section", { type: ["notes"], data: "retained" });
		const controller = new AbortController();
		const terminal = tool.execute("terminal", { type: "result" }, controller.signal);
		controller.abort();
		await expect(terminal).rejects.toThrow();
		acceptSection(section);
		const retry = await tool.execute("retry", { type: "result" });
		expect(retry.details).toMatchObject({ status: "success", useLastTurn: true });
	});

	it("releases old incremental waits on reset without closing the new run", async () => {
		const tool = new YieldTool(createSession());
		const acceptSection = tool.deferResultAcceptance("old-section");
		const section = await tool.execute("old-section", { type: ["notes"], data: "stale" });
		const terminal = tool.execute("old-terminal", { type: "result" });
		tool.resetTurnState();
		await expect(terminal).rejects.toThrow("already submitted");
		acceptSection(section);
		await expect(tool.execute("empty-new-terminal", { type: "result" })).rejects.toThrow("result needs data");
		const result = await tool.execute("new-terminal", { data: "fresh" });
		expect(result.details).toMatchObject({ status: "success", data: "fresh" });
	});

	it("settles forced-final sibling sections after a delayed rejected wrapper without cyclic waits", async () => {
		const tool = new YieldTool(createSession());
		const rejectEarlier = tool.deferResultAcceptance("earlier");
		await expect(tool.execute("earlier", { data: "invalid", error: "conflict" })).rejects.toThrow();
		tool.setFinalResultForced(true);
		const signal = AbortSignal.timeout(1_000);
		const runSection = async (id: string) => {
			const settle = tool.deferResultAcceptance(id);
			try {
				const result = await tool.execute(id, { type: ["notes"], data: id }, signal);
				settle(result);
				return result;
			} catch (error) {
				settle();
				throw error;
			}
		};
		const first = runSection("first");
		const second = runSection("second");
		rejectEarlier();
		const results = await Promise.allSettled([first, second]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		const accepted = results.find(result => result.status === "fulfilled");
		expect(accepted?.status === "fulfilled" ? accepted.value.details : undefined).toMatchObject({
			status: "success",
			type: ["notes"],
			complete: true,
			data: "first",
		});
	});

	it("accepts only one of two concurrent sibling terminal yields", async () => {
		const tool = new YieldTool(createSession());
		const results = await Promise.allSettled([
			tool.execute("call-a", { data: { answer: "a" } } as never),
			tool.execute("call-b", { data: { answer: "b" } } as never),
		]);
		expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
	});

	it("refuses terminal acceptance alongside other tool calls, then allows a separate retry", async () => {
		const tool = new YieldTool(createSession());
		await expect(
			tool.execute("finish", { data: "done" }, undefined, undefined, {
				toolCall: {
					batchId: "batch",
					index: 0,
					total: 2,
					toolCalls: [
						{ id: "finish", name: "yield" },
						{ id: "start", name: "bash" },
					],
				},
			} as never),
		).rejects.toThrow("separate response");
		const retry = await tool.execute("retry", { data: "finished after tools" });
		expect(retry.details).toMatchObject({ status: "success", data: "finished after tools" });
	});

	it("retains a listed service after describe failure and stops it before abandonment", async () => {
		const service = {
			name: "owned",
			owner: "worker",
			persist: false,
			detached: false,
			state: "running",
			startedAt: 1,
		};
		spyOn(launchServices, "hasLiveOwnedService").mockReturnValue(true);
		spyOn(launchServices, "listServicesTolerant").mockResolvedValue({ services: [service] } as never);
		spyOn(launchClient, "daemonClientForProject").mockResolvedValue({
			request: async () => {
				throw new Error("describe unavailable");
			},
		} as never);
		const stop = spyOn(launchServices, "stopService").mockResolvedValue({ ...service, state: "exited" } as never);
		const tool = new YieldTool(createSession({ requireYieldTool: true, getAgentId: () => "worker" }));
		await expect(tool.execute("first", { data: "done" })).rejects.toThrow("owned");
		expect(stop).not.toHaveBeenCalled();
		const accepted = await tool.execute("retry", { data: "done" });
		expect(stop).toHaveBeenCalledTimes(1);
		expect(accepted.details?.abandonedJobs).toMatchObject([{ id: "owned", type: "service", command: "owned" }]);
	});

	it("keeps refusing when owned-service discovery repeatedly fails", async () => {
		spyOn(launchServices, "hasLiveOwnedService").mockReturnValue(true);
		spyOn(launchServices, "listServicesTolerant").mockResolvedValue({ services: [], error: "broker unavailable" });
		spyOn(launchClient, "daemonClientForProject").mockResolvedValue({} as never);
		const tool = new YieldTool(createSession({ requireYieldTool: true }));
		await expect(tool.execute("first", { data: "done" })).rejects.toThrow("broker unavailable");
		await expect(tool.execute("retry", { data: "done" })).rejects.toThrow("broker unavailable");
	});

	it("reserves the final workpool key across sibling calls and releases refused claims", async () => {
		let running = true;
		const tool = new YieldTool(
			createSession({
				requireYieldTool: true,
				getWorkPoolYieldItems: () => [{ id: "review#1", index: 1 }],
				asyncJobManager: {
					getRunningJobs: () =>
						running ? [{ id: "job-1", type: "bash", status: "running", startTime: 1, label: "build" }] : [],
				} as never,
			}),
		);
		const refused = await Promise.allSettled([
			tool.execute("first", { key: 1, data: "first" }),
			tool.execute("sibling", { key: 1, data: "sibling" }),
		]);
		expect(refused.every(result => result.status === "rejected")).toBe(true);
		running = false;
		const accepted = await Promise.allSettled([
			tool.execute("retry", { key: 1, data: "retry" }),
			tool.execute("retry-sibling", { key: 1, data: "retry sibling" }),
		]);
		expect(accepted.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(accepted.filter(result => result.status === "rejected")).toHaveLength(1);
		const result = accepted.find(result => result.status === "fulfilled");
		expect(result?.status === "fulfilled" && result.value.details).toMatchObject({ data: "retry", complete: true });
	});

	it("releases an aborted sibling reservation without losing the accepted predecessor", async () => {
		const tool = new YieldTool(
			createSession({
				getWorkPoolYieldItems: () => [
					{ id: "one", index: 1 },
					{ id: "two", index: 2 },
				],
			}),
		);
		const acceptFirst = tool.deferResultAcceptance("first");
		const first = await tool.execute("first", { key: 1, data: "one" });
		const controller = new AbortController();
		const second = tool.execute("second", { key: 2, data: "two" }, controller.signal);
		controller.abort();
		await expect(second).rejects.toThrow();
		acceptFirst(first);
		const retry = await tool.execute("retry", { key: 2, data: "two" });
		expect(retry.details).toMatchObject({ data: "two", complete: true });
	});

	it("does not let pending old wrappers mark the next run's workpool keys accepted", async () => {
		const tool = new YieldTool(
			createSession({
				getWorkPoolYieldItems: () => [
					{ id: "one", index: 1 },
					{ id: "two", index: 2 },
				],
			}),
		);
		const acceptOld = tool.deferResultAcceptance("old-first");
		const oldFirst = await tool.execute("old-first", { key: 1, data: "old one" });
		const oldSecond = tool.execute("old-second", { key: 2, data: "old two" });
		tool.resetTurnState();
		await oldSecond;
		acceptOld(oldFirst);
		const first = await tool.execute("new-first", { key: 1, data: "new one" });
		expect(first.details?.complete).not.toBe(true);
		const second = await tool.execute("new-second", { key: 2, data: "new two" });
		expect(second.details).toMatchObject({ data: "new two", complete: true });
	});

	it("submits a workpool item error without aborting the batch and fences final acceptance behind running jobs", async () => {
		let running = true;
		const tool = new YieldTool(
			createSession({
				requireYieldTool: true,
				getWorkPoolYieldItems: () => [
					{ id: "review#1", index: 1 },
					{ id: "review#2", index: 2 },
				],
				asyncJobManager: {
					getRunningJobs: () =>
						running ? [{ id: "build", type: "bash", status: "running", startTime: 1, label: "build" }] : [],
				} as never,
			}),
		);
		const failedItem = await tool.execute("item-error", { key: 1, error: "item unavailable" });
		expect(failedItem.details).toMatchObject({
			status: "success",
			data: { error: "item unavailable" },
			type: ["review#1"],
		});
		expect(failedItem.details?.complete).not.toBe(true);
		await expect(tool.execute("duplicate-item", { key: 1, data: "duplicate" })).rejects.toThrow("already submitted");
		await expect(tool.execute("blocked-last", { key: 2, data: "done" })).rejects.toThrow("build");
		running = false;
		const final = await tool.execute("last-item-error", { key: 2, error: "second unavailable" });
		expect(final.details).toMatchObject({ status: "success", data: { error: "second unavailable" }, complete: true });
	});

	it("rejects empty data for any terminal type and accepts schema-valid empty values", async () => {
		const typed = new YieldTool(createSession());
		await expect(typed.execute("call-summary-empty", { type: "summary", data: "" } as never)).rejects.toThrow(
			/result needs data/,
		);
		const ok = await typed.execute("call-summary", { type: "summary", data: "done" } as never);
		expect(ok.details).toMatchObject({ status: "success", data: "done" });

		const schemaTool = new YieldTool(createSession({ outputSchema: { type: "array", items: { type: "string" } } }));
		const empty = await schemaTool.execute("call-empty-array", { type: "result", data: [] } as never);
		expect(empty.details).toMatchObject({ status: "success", data: [] });
	});

	it("awaits the claim when aborting after repeated stray-key yields", async () => {
		const tool = new YieldTool(createSession());
		for (let i = 0; i < 3; i++) {
			await expect(tool.execute(`call-stray-${i}`, { type: "summary", result: "answer" } as never)).rejects.toThrow(
				/no `data`/,
			);
		}
		const aborted = await tool.execute("call-stray-abort", { type: "summary", result: "answer" } as never);
		expect(aborted.details).toMatchObject({ status: "aborted" });
		await expect(tool.execute("call-after-abort", { data: { answer: 1 } } as never)).rejects.toThrow("Stop now");
	});

	it("refuses a terminal yield while any owner job runs, then rolls the latch back", async () => {
		const job = { id: "job-1", type: "eval", status: "running", startTime: Date.now(), label: "\x1b[31mcell\x1b[0m" };
		const tool = new YieldTool(
			createSession({
				requireYieldTool: true,
				getAgentId: () => "worker",
				asyncJobManager: {
					// Foreground-backed owner jobs are reaped at teardown, so the guard must ask for them.
					getRunningJobs: (filter?: { ownerId?: string }, options?: { includeForeground?: boolean }) =>
						filter?.ownerId === "worker" && options?.includeForeground === true ? [job] : [],
				} as never,
			}),
		);
		const refusal = await tool.execute("call-refused", { data: { answer: 1 } } as never).catch(error => error);
		expect(refusal).toBeInstanceOf(Error);
		expect(String(refusal.message)).toContain("job-1");
		expect(String(refusal.message)).not.toContain("\x1b");
		const accepted = await tool.execute("call-repeat", { data: { answer: 1 } } as never);
		expect(accepted.details).toMatchObject({ status: "success" });
		expect((accepted.details as { abandonedJobs?: Array<{ type: string }> }).abandonedJobs?.[0]?.type).toBe("eval");
	});

	it("allows incremental yields only before terminal acceptance", async () => {
		const tool = new YieldTool(createSession());
		await tool.execute("call-section", { type: ["notes"], data: { note: "first" } } as never);
		await tool.execute("call-terminal", { data: { answer: 42 } } as never);
		await expect(tool.execute("call-later-section", { type: ["notes"], data: "later" } as never)).rejects.toThrow(
			"Stop now",
		);
		await expect(tool.execute("call-later-terminal", { data: { answer: 0 } } as never)).rejects.toThrow("Stop now");
	});

	it("rejects an empty terminal result as a retryable error without completing (#108)", async () => {
		// Missing data: the first yield bounces in-band and latches nothing, so a
		// resubmission with the payload completes.
		const tool = new YieldTool(createSession());
		await expect(tool.execute("call-empty-result", { type: "result" } as never)).rejects.toThrow(/result needs data/);
		const done = await tool.execute("call-real-result", {
			type: "result",
			data: { verdict: "clean" },
		} as never);
		expect(done.details).toMatchObject({ status: "success", data: { verdict: "clean" } });

		// Explicitly empty payloads bounce the same way, then a real one completes.
		const blank = new YieldTool(createSession());
		await expect(blank.execute("call-blank", { type: "result", data: "" } as never)).rejects.toThrow(
			/result needs data/,
		);
		await expect(blank.execute("call-empty-object", { type: "result", data: {} } as never)).rejects.toThrow(
			/result needs data/,
		);
		await expect(blank.execute("call-empty-array", { type: "result", data: [] } as never)).rejects.toThrow(
			/result needs data/,
		);
		const filled = await blank.execute("call-filled", {
			type: "result",
			data: { verdict: "clean" },
		} as never);
		expect(filled.details).toMatchObject({ status: "success", data: { verdict: "clean" } });

		// Negative control: an error yield without data still completes as an error.
		const failing = new YieldTool(createSession());
		const failed = await failing.execute("call-error", { type: "error", error: "x" } as never);
		expect(failed.details).toMatchObject({ status: "aborted", error: "x" });
	});
});
