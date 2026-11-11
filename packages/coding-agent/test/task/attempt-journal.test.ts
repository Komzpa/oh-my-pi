import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	AttemptJournal,
	createAttemptJournalProjection,
	decodeAttemptJournalEvent,
	getAttemptJournalAssignment,
	replayAttemptJournalEvents,
} from "../../src/task/attempt-journal";
import type { AttemptJournalAttempt, JsonValue } from "../../src/task/attempt-journal-types";
import { importLegacyAttemptJournal } from "../../src/task/attempt-journal-import";

type Command = Parameters<AttemptJournal["append"]>[0];
const owner = { ownerName: "worker", workerId: "worker-1", childSessionId: "child-1", leaseEpoch: 1 };
const zero = {
	expectedRevision: 0,
	expectedAttempt: 0,
	expectedGeneration: 0,
	expectedLeaseEpoch: 0,
	expectedRowRevision: 0,
};

async function withJournal(run: (journal: AttemptJournal, file: string) => Promise<void>): Promise<void> {
	await fs.mkdir(path.resolve(".tmp"), { recursive: true });
	const dir = await fs.mkdtemp(path.resolve(".tmp", "attempt-journal-test-"));
	const file = path.join(dir, "journal.jsonl");
	const journal = await AttemptJournal.open({ path: file, leadSessionId: "lead", blobDir: path.join(dir, "blobs") });
	try {
		await run(journal, file);
	} finally {
		await journal.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function taskCommand(kind: string, overrides: Record<string, unknown> = {}): Command {
	return {
		commandId: kind,
		kind,
		taskId: "task-1",
		rowId: "row-1",
		purpose: "work",
		attempt: 1,
		generation: 1,
		state: "queued",
		owner,
		...zero,
		...overrides,
	} as Command;
}

function cas(journal: AttemptJournal): Record<string, number> {
	const task = journal.snapshot().tasks["task-1"];
	if (!task) return { ...zero };
	const attempt = task.attempts[String(task.currentAttempt)];
	return {
		expectedRevision: task.revision,
		expectedAttempt: task.currentAttempt,
		expectedGeneration: attempt.generation,
		expectedLeaseEpoch: attempt.leaseEpoch,
		expectedRowRevision: journal.snapshot().rows["row-1"]?.revision ?? 0,
	};
}

async function running(journal: AttemptJournal): Promise<void> {
	await journal.append(taskCommand("AttemptQueued"));
	await journal.append(taskCommand("AttemptStarted", { state: "running", ...cas(journal) }));
}

function resultCommand(journal: AttemptJournal, commandId: string): Command {
	const data = "Result bytes written by the worker\n";
	const sha256 = new Bun.SHA256().update(data).digest("hex");
	return taskCommand("ResultCommitted", {
		commandId,
		state: "succeeded",
		...cas(journal),
		result: { artifactUri: `blob:sha256:${sha256}`, sha256, mediaType: "text/plain", executionOutcome: "success" },
		artifact: { data, mediaType: "text/plain" },
	});
}

const attemptStates = ["queued", "running", "succeeded", "failed", "aborted", "cancelled"] as const;
const attemptKinds = {
	queued: "AttemptQueued",
	running: "AttemptStarted",
	succeeded: "ResultCommitted",
	failed: "ResultCommitted",
	aborted: "AttemptAborted",
	cancelled: "AttemptCancelled",
} as const;

async function transition(journal: AttemptJournal, state: (typeof attemptStates)[number], id: string): Promise<void> {
	if (state === "succeeded" || state === "failed") {
		const command = resultCommand(journal, id);
		if (command.kind !== "ResultCommitted") throw new Error("Expected result command");
		await journal.append({
			...command,
			state,
			result: { ...command.result, executionOutcome: state === "failed" ? "failure" : "success" },
		});
	} else {
		await journal.append(taskCommand(attemptKinds[state], { commandId: id, state, ...cas(journal) }));
	}
}

async function reach(journal: AttemptJournal, state: (typeof attemptStates)[number]): Promise<void> {
	await journal.append(taskCommand("AttemptQueued"));
	if (state === "queued") return;
	if (state === "aborted" || state === "cancelled") {
		await transition(journal, state, `reach-${state}`);
		return;
	}
	await transition(journal, "running", "reach-running");
	if (state !== "running") await transition(journal, state, `reach-${state}`);
}

describe("attempt journal", () => {
	it("rebuilds an empty committed prefix without inventing work", () => {
		expect(replayAttemptJournalEvents([], "lead")).toEqual(createAttemptJournalProjection("lead"));
	});

	it("absent and unresolved attempts cannot skip queued creation or explicit adoption", async () => {
		for (const state of ["absent", "unknown", "legacy-unresolved"])
			for (const kind of ["AttemptStarted", "ResultCommitted", "AttemptAborted", "AttemptCancelled"]) {
				await withJournal(async journal => {
					if (state !== "absent")
						await journal.append(
							taskCommand("LegacyImported", {
								commandId: "import",
								state,
								source: { fingerprint: "source", entryIds: ["entry"] },
							}),
						);
					const expected = state === "absent" ? zero : cas(journal);
					const command =
						kind === "ResultCommitted"
							? resultCommand(journal, "try-result")
							: taskCommand(kind, {
									commandId: "try",
									state:
										kind === "AttemptStarted"
											? "running"
											: kind === "AttemptCancelled"
												? "cancelled"
												: "aborted",
									...expected,
								});
					await expect(journal.append(command)).rejects.toThrow();
				});
			}
	});

	it("only allowed attempt state transitions are accepted", async () => {
		const allowed: Record<string, true> = {
			"queued:running": true,
			"queued:aborted": true,
			"queued:cancelled": true,
			"running:succeeded": true,
			"running:failed": true,
			"running:aborted": true,
			"running:cancelled": true,
		};
		for (const from of attemptStates)
			for (const to of attemptStates) {
				await withJournal(async journal => {
					await reach(journal, from);
					const action = transition(journal, to, `transition-${from}-${to}`);
					if (allowed[`${from}:${to}`]) {
						await action;
						expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe(to);
					} else {
						await expect(action).rejects.toThrow();
						expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe(from);
					}
				});
			}
	});

	it("repeated command returns original sequence", async () => {
		await withJournal(async (journal, file) => {
			const command = taskCommand("AttemptQueued");
			const first = await journal.append(command);
			expect((await journal.append(command)).seq).toBe(first.seq);
			await journal.close();
			const reopened = await AttemptJournal.open({ path: file, leadSessionId: "lead" });
			try {
				expect((await reopened.append(command)).seq).toBe(first.seq);
				await expect(reopened.append({ ...command, state: "running" } as Command)).rejects.toThrow();
			} finally {
				await reopened.close();
			}
		});
	});

	it("one terminal result per task attempt", async () => {
		await withJournal(async (journal, file) => {
			await running(journal);
			const command = resultCommand(journal, "result-1");
			if (command.kind !== "ResultCommitted") throw new Error("Expected result command");
			await journal.append(command);
			const bytes = await fs.readFile(path.join(path.dirname(file), "blobs", command.result.sha256));
			expect(new Bun.SHA256().update(bytes).digest("hex")).toBe(command.result.sha256);
			expect(bytes.toString()).toBe(command.artifact!.data);
			await expect(journal.append(resultCommand(journal, "result-2"))).rejects.toThrow();
			expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("succeeded");
		});
	});

	it("generation and custody events cannot replace a committed artifact", async () => {
		await withJournal(async journal => {
			await running(journal);
			await journal.append(resultCommand(journal, "accepted"));
			const before = journal.snapshot();
			const data = "smuggled replacement";
			const sha256 = new Bun.SHA256().update(data).digest("hex");
			for (const kind of ["GenerationAdvanced", "OwnerTransferred"]) {
				const command = taskCommand(kind, {
					commandId: `smuggle-${kind}`,
					state: "succeeded",
					generation: kind === "GenerationAdvanced" ? 2 : 1,
					owner: { ...owner, leaseEpoch: 2 },
					...cas(journal),
					result: {
						artifactUri: `blob:sha256:${sha256}`,
						sha256,
						mediaType: "text/plain",
						executionOutcome: "success",
					},
				});
				await expect(journal.append(command)).rejects.toThrow("result payload is not allowed");
				expect(journal.snapshot()).toEqual(before);
			}
		});
	});

	it("an existing attempt cannot change its bound row or purpose", async () => {
		await withJournal(async journal => {
			await running(journal);
			const before = journal.snapshot();
			for (const change of [{ rowId: "other-row" }, { purpose: "observe" }, { purpose: "audit" }]) {
				await expect(
					journal.append(
						taskCommand("CheckpointRecorded", {
							commandId: "move",
							state: "running",
							checkpoint: "child.jsonl",
							...cas(journal),
							...change,
						}),
					),
				).rejects.toThrow("attempt row and purpose are immutable");
				expect(journal.snapshot()).toEqual(before);
			}
		});
	});

	it("stale generation is refused", async () => {
		await withJournal(async journal => {
			await running(journal);
			const stale = cas(journal);
			await journal.append(
				taskCommand("GenerationAdvanced", {
					state: "running",
					generation: 2,
					owner: { ...owner, leaseEpoch: 2 },
					...stale,
				}),
			);
			await expect(
				journal.append(
					taskCommand("AttemptAborted", {
						commandId: "stale-abort",
						state: "aborted",
						generation: 2,
						owner: { ...owner, leaseEpoch: 2 },
						...cas(journal),
						expectedGeneration: stale.expectedGeneration,
					}),
				),
			).rejects.toThrow();
			await expect(
				journal.append(
					taskCommand("AttemptAborted", {
						commandId: "stale-event-generation",
						state: "aborted",
						generation: 1,
						owner: { ...owner, leaseEpoch: 2 },
						...cas(journal),
					}),
				),
			).rejects.toThrow();
			expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("running");
		});
	});

	it("late process abort cannot overwrite a committed result", async () => {
		await withJournal(async journal => {
			await running(journal);
			const stale = cas(journal);
			await journal.append(resultCommand(journal, "result"));
			await expect(
				journal.append(taskCommand("AttemptAborted", { commandId: "late-abort", state: "aborted", ...stale })),
			).rejects.toThrow();
			await expect(
				journal.append(
					taskCommand("AttemptAborted", { commandId: "fresh-abort", state: "aborted", ...cas(journal) }),
				),
			).rejects.toThrow();
			expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("succeeded");
		});
	});

	it("stale revision, attempt, generation and lease are refused", async () => {
		await withJournal(async journal => {
			await running(journal);
			const current = cas(journal);
			for (const field of [
				"expectedRevision",
				"expectedAttempt",
				"expectedGeneration",
				"expectedLeaseEpoch",
				"expectedRowRevision",
			]) {
				await expect(
					journal.append(
						taskCommand("AttemptAborted", {
							commandId: `stale-${field}`,
							state: "aborted",
							...current,
							[field]: 0,
						}),
					),
				).rejects.toThrow();
			}
			expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("running");
		});
	});

	it("seeded committed prefixes replay to the live projection", async () => {
		let seed = 0x32fc19;
		for (let sample = 0; sample < 6; sample++)
			await withJournal(async (journal, file) => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				const check = async () => {
					const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
					expect(replayAttemptJournalEvents(lines.map(decodeAttemptJournalEvent), "lead")).toEqual(
						journal.snapshot(),
					);
				};
				const append = async (command: Command) => {
					const event = await journal.append(command);
					await check();
					return event;
				};
				await check();
				await append(taskCommand("AttemptQueued"));
				await append(taskCommand("AttemptStarted", { state: "running", ...cas(journal) }));
				await append(taskCommand("AttemptAborted", { state: "aborted", ...cas(journal) }));
				await append(taskCommand("AttemptQueued", { commandId: "second", attempt: 2, ...cas(journal) }));
				await append(
					taskCommand("AttemptStarted", {
						commandId: "second-start",
						attempt: 2,
						state: "running",
						...cas(journal),
					}),
				);
				await append(
					taskCommand("CheckpointRecorded", {
						commandId: "checkpoint",
						attempt: 2,
						state: "running",
						checkpoint: "child.jsonl",
						...cas(journal),
					}),
				);
				const request = {
					kind: "RestartTransition" as const,
					requestId: "restart",
					affectedAttempts: [{ taskId: "task-1", attempt: 2 }],
				};
				for (const state of ["queued", "draining", "ready", "restoring"] as const)
					await append({ ...request, state, commandId: `restart-${state}` });
				const state = (["completed", "failed", "cancelled"] as const)[seed % 3];
				const terminal = await append({
					...request,
					state,
					commandId: "restart-terminal",
					reason: "seeded terminal transition",
					accountedChildren: ["child-1"],
				});
				for (const commandId of ["notice", "notice-retry"])
					await append({
						kind: "NoticeApplied",
						commandId,
						requestId: "restart",
						childSessionId: "child-1",
						terminalEventSeq: terminal.seq,
					});
				expect(journal.snapshot().notices["child-1"].keys).toEqual([`restart\0${terminal.seq}`]);
				const result = resultCommand(journal, "result");
				if (result.kind !== "ResultCommitted") throw new Error("Expected result command");
				const outcome = seed % 2 === 0 ? "succeeded" : "failed";
				await append({
					...result,
					attempt: 2,
					state: outcome,
					result: { ...result.result, executionOutcome: outcome === "succeeded" ? "success" : "failure" },
				});
				await append(
					taskCommand("GenerationAdvanced", {
						commandId: "revive",
						attempt: 2,
						generation: 2,
						state: outcome,
						owner: { ...owner, leaseEpoch: 2 },
						...cas(journal),
					}),
				);
				expect(getAttemptJournalAssignment(journal.snapshot(), "row-1")).toMatchObject({
					attempt: 2,
					state: outcome,
					generation: 2,
				});
				await append(
					taskCommand("OwnerTransferred", {
						commandId: "custody",
						attempt: 2,
						generation: 2,
						state: outcome,
						owner: { ...owner, leaseEpoch: 3 },
						...cas(journal),
					}),
				);
				await append(
					taskCommand("AttemptQueued", {
						commandId: "observer",
						taskId: "observer",
						purpose: "observe",
						owner: { ...owner, workerId: "observer" },
					}),
				);
				expect(journal.snapshot().rows["row-1"].owner?.workerId).toBe(owner.workerId);
				await append(
					taskCommand("AttemptQueued", {
						commandId: "audit",
						taskId: "audit",
						purpose: "audit",
						owner: { ...owner, workerId: "auditor" },
						expectedRowRevision: journal.snapshot().rows["row-1"].revision,
					}),
				);
				expect(getAttemptJournalAssignment(journal.snapshot(), "row-1")?.state).toBe(outcome);
				await append(
					taskCommand("AttemptCancelled", {
						commandId: "audit-stop",
						taskId: "audit",
						purpose: "audit",
						state: "cancelled",
						owner: { ...owner, workerId: "auditor" },
						expectedRevision: journal.snapshot().tasks.audit.revision,
						expectedAttempt: 1,
						expectedGeneration: 1,
						expectedLeaseEpoch: 1,
						expectedRowRevision: journal.snapshot().rows["row-1"].revision,
					}),
				);
				await append(taskCommand("AttemptQueued", { commandId: "third", attempt: 3, ...cas(journal) }));
				await append(
					taskCommand("AttemptStarted", {
						commandId: "third-start",
						attempt: 3,
						state: "running",
						...cas(journal),
					}),
				);
				expect(getAttemptJournalAssignment(journal.snapshot(), "row-1")).toMatchObject({
					attempt: 3,
					state: "running",
				});
				expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("aborted");
				for (const command of importLegacyAttemptJournal({
					leadSessionId: "lead",
					children: [{ id: "legacy-child", sessionFile: "legacy.jsonl", entries: [] }],
				}))
					await append(command);
			});
	});

	it("reopen discards an incomplete tail but keeps committed commands", async () => {
		await withJournal(async (journal, file) => {
			const command = taskCommand("AttemptQueued");
			const first = await journal.append(command);
			await journal.close();
			await fs.appendFile(file, '{"v":1,"seq":');
			const reopened = await AttemptJournal.open({ path: file, leadSessionId: "lead" });
			try {
				expect((await reopened.append(command)).seq).toBe(first.seq);
				expect(reopened.snapshot().tasks["task-1"].attempts["1"].state).toBe("queued");
			} finally {
				await reopened.close();
			}
		});
	});

	it("reopen adopts a complete unacknowledged final record and preserves its sequence", async () => {
		await withJournal(async (journal, file) => {
			const first = await journal.append(taskCommand("AttemptQueued"));
			const command = taskCommand("AttemptStarted", { state: "running", ...cas(journal) });
			await journal.close();
			const event = {
				...command,
				v: 1,
				leadSessionId: "lead",
				seq: first.seq + 1,
				writerEpoch: first.writerEpoch,
				at: "2026-01-01T00:00:00.000Z",
			};
			await fs.appendFile(file, `${JSON.stringify(event)}\n`);
			const reopened = await AttemptJournal.open({ path: file, leadSessionId: "lead" });
			try {
				expect((await reopened.append(command)).seq).toBe(event.seq);
				expect(reopened.snapshot().tasks["task-1"].attempts["1"].state).toBe("running");
			} finally {
				await reopened.close();
			}
		});
	});

	it("reopen rejects interior corruption and unknown journal versions", async () => {
		for (const corruption of ["interior", "version"])
			await withJournal(async (journal, file) => {
				await journal.append(taskCommand("AttemptQueued"));
				await journal.close();
				const lines = (await fs.readFile(file, "utf8")).trimEnd().split("\n");
				if (corruption === "interior") lines.splice(1, 0, "not-json");
				else lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), v: 2 });
				await fs.writeFile(file, `${lines.join("\n")}\n`);
				await expect(AttemptJournal.open({ path: file, leadSessionId: "lead" })).rejects.toThrow();
			});
	});

	it("only allowed restart transitions are accepted", async () => {
		const states = ["queued", "draining", "ready", "restoring", "completed", "failed", "cancelled"] as const;
		const allowed: Record<string, true> = {
			"queued:draining": true,
			"draining:ready": true,
			"ready:restoring": true,
			"restoring:completed": true,
		};
		for (const from of states)
			for (const to of states) {
				await withJournal(async journal => {
					const append = (state: (typeof states)[number], commandId: string) =>
						journal.append({
							kind: "RestartTransition",
							commandId,
							requestId: "restart-1",
							state,
							affectedAttempts: [],
							reason: "explicit terminal reason",
							accountedChildren: [],
						});
					await append("queued", "initial");
					if (from === "failed" || from === "cancelled") await append(from, "reach-terminal");
					else
						for (const state of states.slice(1, states.indexOf(from) + 1)) await append(state, `reach-${state}`);
					const action = append(to, `try-${from}-${to}`);
					const permitted =
						allowed[`${from}:${to}`] ||
						(["queued", "draining", "ready", "restoring"].includes(from) &&
							(to === "failed" || to === "cancelled"));
					if (permitted) await action;
					else await expect(action).rejects.toThrow();
					expect(journal.snapshot().restarts["restart-1"].state).toBe(permitted ? to : from);
				});
			}
	});

	it("generation advancement permits exactly the next fenced generation and preserves accepted results", async () => {
		for (const delta of [-1, 0, 1, 2])
			await withJournal(async journal => {
				await running(journal);
				await journal.append(resultCommand(journal, "accepted"));
				const before = journal.snapshot().tasks["task-1"].attempts["1"].result;
				const action = journal.append(
					taskCommand("GenerationAdvanced", {
						commandId: `g${delta}`,
						...cas(journal),
						generation: 1 + delta,
						state: "succeeded",
						owner: { ...owner, leaseEpoch: 2 },
					}),
				);
				if (delta === 1) await action;
				else await expect(action).rejects.toThrow();
				expect(journal.snapshot().tasks["task-1"].attempts["1"].result).toEqual(before);
			});
	});

	it("owner replacement and release require fresh custody and cannot change outcome", async () => {
		for (const next of [
			null,
			{ ...owner, leaseEpoch: 2 },
			{ ...owner, workerId: "replacement", ownerName: "replacement", leaseEpoch: 2 },
			{ ...owner, workerId: "intruder" },
		]) {
			await withJournal(async journal => {
				await running(journal);
				const action = journal.append(
					taskCommand("OwnerTransferred", {
						commandId: "transfer",
						state: "running",
						...cas(journal),
						owner: next,
					}),
				);
				if (next && next.leaseEpoch === 1) await expect(action).rejects.toThrow();
				else {
					await action;
					expect(journal.snapshot().rows["row-1"].owner).toEqual(next);
				}
			});
		}
		await withJournal(async journal => {
			await running(journal);
			await expect(
				journal.append(
					taskCommand("AttemptAborted", {
						state: "aborted",
						...cas(journal),
						owner: { ...owner, workerId: "intruder" },
					}),
				),
			).rejects.toThrow();
		});
	});

	it("only unresolved legacy evidence permits explicit adoption", async () => {
		for (const from of ["unknown", "legacy-unresolved", "queued", "running", "aborted", "cancelled"])
			for (const to of ["unknown", "legacy-unresolved", "queued", "running", "aborted", "cancelled"]) {
				await withJournal(async journal => {
					await journal.append(
						taskCommand("LegacyImported", {
							commandId: "legacy",
							state: from,
							owner: null,
							source: { fingerprint: "source", entryIds: ["entry"] },
						}),
					);
					const action = journal.append(
						taskCommand("LegacyAdopted", {
							commandId: "adopt",
							state: to,
							...cas(journal),
							generation: 2,
							owner: { ...owner, leaseEpoch: 2 },
							source: { fingerprint: "source", entryIds: ["entry"] },
						}),
					);
					if (from === "legacy-unresolved" && to !== "unknown" && to !== "legacy-unresolved") await action;
					else await expect(action).rejects.toThrow();
				});
			}
	});

	it("released custody cannot revive an old lease", async () => {
		await withJournal(async journal => {
			await running(journal);
			await journal.append(
				taskCommand("OwnerTransferred", { commandId: "release", state: "running", ...cas(journal), owner: null }),
			);
			await expect(
				journal.append({ ...resultCommand(journal, "unowned-result"), owner: null } as Command),
			).rejects.toThrow("result requires owned running attempt");
			await expect(
				journal.append(
					taskCommand("OwnerTransferred", { commandId: "old-rebind", state: "running", ...cas(journal), owner }),
				),
			).rejects.toThrow();
			await journal.append(
				taskCommand("OwnerTransferred", {
					commandId: "new-rebind",
					state: "running",
					...cas(journal),
					owner: { ...owner, leaseEpoch: 2 },
				}),
			);
			await expect(
				journal.append(
					taskCommand("AttemptAborted", {
						commandId: "old-custodian",
						state: "aborted",
						...cas(journal),
						expectedLeaseEpoch: 1,
						owner,
					}),
				),
			).rejects.toThrow();
			expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("running");
		});
		await withJournal(async journal => {
			await journal.append(taskCommand("AttemptQueued"));
			await journal.append(taskCommand("OwnerTransferred", { commandId: "release", ...cas(journal), owner: null }));
			await expect(
				journal.append(taskCommand("AttemptStarted", { state: "running", ...cas(journal), owner: null })),
			).rejects.toThrow("start requires queued attempt with current owner");
			await journal.append(
				taskCommand("OwnerTransferred", {
					commandId: "fresh-owner",
					...cas(journal),
					owner: { ...owner, leaseEpoch: 2 },
				}),
			);
			await journal.append(
				taskCommand("AttemptStarted", { state: "running", ...cas(journal), owner: { ...owner, leaseEpoch: 2 } }),
			);
			expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("running");
		});
	});

	it("a second writer cannot take a live journal lease", async () => {
		await withJournal(async (_journal, file) => {
			await expect(AttemptJournal.open({ path: file, leadSessionId: "lead" })).rejects.toThrow();
		});
	});

	it("latest work assignment ignores old aborts and audit status and shows pending after restaff", async () => {
		await withJournal(async journal => {
			await running(journal);
			await journal.append(
				taskCommand("AttemptAborted", { commandId: "old-abort", state: "aborted", ...cas(journal) }),
			);
			await journal.append(taskCommand("AttemptQueued", { commandId: "restaff", attempt: 2, ...cas(journal) }));
			await journal.append(
				taskCommand("AttemptStarted", { commandId: "second-start", attempt: 2, state: "running", ...cas(journal) }),
			);
			await journal.append({ ...resultCommand(journal, "second-result"), attempt: 2 } as Command);
			expect(getAttemptJournalAssignment(journal.snapshot(), "row-1")).toMatchObject({
				attempt: 2,
				state: "succeeded",
			});
			await journal.append(
				taskCommand("AttemptQueued", {
					commandId: "audit",
					taskId: "audit-task",
					purpose: "audit",
					owner: { ...owner, workerId: "auditor" },
					expectedRowRevision: journal.snapshot().rows["row-1"].revision,
				}),
			);
			expect(getAttemptJournalAssignment(journal.snapshot(), "row-1")).toMatchObject({
				attempt: 2,
				state: "succeeded",
			});
			await journal.append(
				taskCommand("AttemptQueued", {
					commandId: "observer",
					taskId: "observer",
					purpose: "observe",
					owner: { ...owner, workerId: "observer" },
				}),
			);
			expect(journal.snapshot().rows["row-1"].owner?.workerId).toBe("auditor");
			const workResult = getAttemptJournalAssignment(journal.snapshot(), "row-1")?.result;
			const auditRow = journal.snapshot().rows["row-1"];
			await journal.append(
				taskCommand("GenerationAdvanced", {
					commandId: "revive-retained-work",
					attempt: 2,
					generation: 2,
					state: "succeeded",
					owner: { ...owner, leaseEpoch: 2 },
					...cas(journal),
				}),
			);
			expect(journal.snapshot().rows["row-1"]).toEqual(auditRow);
			expect(getAttemptJournalAssignment(journal.snapshot(), "row-1")).toMatchObject({
				generation: 2,
				result: workResult,
			});
			const audit = journal.snapshot().tasks["audit-task"];
			await journal.append(
				taskCommand("AttemptCancelled", {
					commandId: "audit-stop",
					taskId: "audit-task",
					purpose: "audit",
					state: "cancelled",
					owner: { ...owner, workerId: "auditor" },
					expectedRevision: audit.revision,
					expectedAttempt: 1,
					expectedGeneration: 1,
					expectedLeaseEpoch: 1,
					expectedRowRevision: journal.snapshot().rows["row-1"].revision,
				}),
			);
			await journal.append(taskCommand("AttemptQueued", { commandId: "third", attempt: 3, ...cas(journal) }));
			expect(getAttemptJournalAssignment(journal.snapshot(), "row-1")).toMatchObject({
				attempt: 3,
				state: "queued",
			});
			expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("aborted");
		});
	});

	it("terminal notices catch up once logically and stale notices cannot replace the cursor", async () => {
		await withJournal(async journal => {
			const request = { kind: "RestartTransition" as const, requestId: "request", affectedAttempts: [] };
			await journal.append({ ...request, commandId: "request", state: "queued" });
			await expect(
				journal.append({
					kind: "NoticeApplied",
					commandId: "pending-notice",
					childSessionId: "child",
					requestId: "request",
					terminalEventSeq: journal.snapshot().appliedSeq,
				}),
			).rejects.toThrow();
			const terminal = await journal.append({
				...request,
				commandId: "cancel",
				state: "cancelled",
				reason: "explicit cancellation",
			});
			for (const commandId of ["notice-1", "notice-2"])
				await journal.append({
					kind: "NoticeApplied",
					commandId,
					childSessionId: "child",
					requestId: "request",
					terminalEventSeq: terminal.seq,
				});
			expect(journal.snapshot().notices.child).toEqual({
				appliedSeq: terminal.seq,
				keys: [`request\0${terminal.seq}`],
			});
			await expect(
				journal.append({
					kind: "NoticeApplied",
					commandId: "stale-notice",
					childSessionId: "child",
					requestId: "request",
					terminalEventSeq: terminal.seq - 1,
				}),
			).rejects.toThrow();
			expect(journal.snapshot().notices.child.appliedSeq).toBe(terminal.seq);
		});
	});

	it("restart ready requires a checkpoint and completed requires accounted children", async () => {
		await withJournal(async journal => {
			await running(journal);
			const request = {
				kind: "RestartTransition" as const,
				requestId: "r",
				affectedAttempts: [{ taskId: "task-1", attempt: 1 }],
			};
			await journal.append({ ...request, commandId: "r-q", state: "queued" });
			await journal.append({ ...request, commandId: "r-d", state: "draining" });
			await expect(journal.append({ ...request, commandId: "premature-ready", state: "ready" })).rejects.toThrow();
			await journal.append(
				taskCommand("CheckpointRecorded", {
					commandId: "checkpoint",
					state: "running",
					checkpoint: "child.jsonl",
					...cas(journal),
				}),
			);
			await journal.append({ ...request, commandId: "r-ready", state: "ready" });
			await journal.append({ ...request, commandId: "r-restoring", state: "restoring" });
			await expect(
				journal.append({ ...request, commandId: "premature-complete", state: "completed" }),
			).rejects.toThrow();
			await journal.append({
				...request,
				commandId: "r-complete",
				state: "completed",
				accountedChildren: ["child-1"],
			});
			expect(journal.snapshot().restarts.r.state).toBe("completed");
		});
	});

	it("legacy import keeps proven artifacts over abort and refuses conflicting terminal evidence", async () => {
		const artifact = (id: string, workerId: string, bytes: string) => ({
			id,
			workerId,
			data: bytes,
			artifactUri: `data:text/plain,${encodeURIComponent(bytes)}`,
			sha256: new Bun.SHA256().update(bytes).digest("hex"),
			mediaType: "text/plain",
			executionOutcome: "success" as const,
		});
		const custom = (id: string, customType: string, data: unknown) => ({
			type: "custom",
			id,
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			customType,
			data,
		});
		const snapshot = {
			leadSessionId: "lead",
			entries: [
				custom("r1", "restart_request_transition", {
					version: 1,
					identity: { instanceId: "i", sessionId: "lead", generation: 9 },
					record: {
						version: 1,
						requestId: "request",
						sessionId: "lead",
						state: "checkpointed",
						requestedAt: 1,
						updatedAt: 2,
						rootWasRunning: true,
					},
				}),
				custom("h1", "subagent_restart_handoff", {
					version: 1,
					rootSessionId: "lead",
					rootSessionFile: "root.jsonl",
					capturedAt: 3,
					requestId: "request",
					children: [
						{
							id: "worker-1",
							sessionFile: "child.jsonl",
							displayName: "same",
							status: "running",
							settled: false,
						},
					],
				}),
				custom("k1", "subagent_restart_receipt", {
					version: 1,
					rootSessionId: "lead",
					handoffId: "h1",
					id: "worker-1",
					sessionFile: "child.jsonl",
					outcome: "settled-during-restart",
					recordedAt: 4,
				}),
			],
			todoPhases: [
				{
					name: "phase",
					tasks: [
						{
							id: "row-1",
							content: "work",
							status: "in_progress",
							schedule: {
								executor: { workerId: "worker-1", startedAt: 1, finishedAt: 2, outcome: "aborted" },
								attemptHistory: [
									{
										attemptId: "worker-1:1",
										workerName: "worker-1",
										startedAt: 1,
										finishedAt: 2,
										terminalStatus: "aborted",
										deliverablePaths: [],
									},
								],
							},
						},
					],
				},
			],
			artifacts: [
				artifact("a1", "worker-1", "accepted bytes"),
				artifact("b1", "worker-2", "first"),
				artifact("b2", "worker-2", "second"),
			],
			children: [
				{
					id: "saved-worker",
					entries: [
						{
							type: "session_init",
							id: "init",
							outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
						},
						{
							type: "message",
							id: "yield-call",
							message: {
								role: "assistant",
								content: [{ type: "toolCall", id: "call", name: "yield", arguments: { data: { value: 42 } } }],
							},
						},
						{
							type: "message",
							id: "yield-result",
							message: {
								role: "toolResult",
								toolCallId: "call",
								isError: false,
								details: { data: { value: 42 } },
							},
						},
					],
				},
			],
		};
		const commands = importLegacyAttemptJournal(snapshot);
		expect(importLegacyAttemptJournal(snapshot)).toEqual(commands);
		const imported = commands.filter(command => command.kind === "LegacyImported");
		const accepted = imported.find(command => command.taskId === "worker-1:1");
		expect(accepted).toMatchObject({ state: "succeeded", result: { sha256: snapshot.artifacts[0].sha256 } });
		expect(accepted?.generation).not.toBe(9);
		expect(imported.find(command => command.taskId === "worker-2")).toMatchObject({ state: "legacy-unresolved" });
		expect(commands.find(command => command.kind === "LegacyRestartImported")).toMatchObject({
			requestId: "request",
			state: "ready",
		});
		expect(imported.find(command => command.taskId === "saved-worker")).toMatchObject({ state: "succeeded" });
		await withJournal(async (journal, file) => {
			const sequences: number[] = [];
			for (const command of commands) sequences.push((await journal.append(command)).seq);
			const before = journal.snapshot();
			await journal.close();
			const reopened = await AttemptJournal.open({
				path: file,
				leadSessionId: "lead",
				blobDir: path.join(path.dirname(file), "blobs"),
			});
			try {
				for (const [index, command] of importLegacyAttemptJournal(snapshot).entries())
					expect((await reopened.append(command)).seq).toBe(sequences[index]);
				expect(reopened.snapshot().tasks).toEqual(before.tasks);
				expect(reopened.snapshot().restarts).toEqual(before.restarts);
				const result = reopened.snapshot().tasks["worker-1:1"].attempts["0"].result;
				if (!result) throw new Error("Missing imported result");
				const bytes = await fs.readFile(path.join(path.dirname(file), "blobs", result.sha256));
				expect(bytes.toString()).toBe("accepted bytes");
				expect(new Bun.SHA256().update(bytes).digest("hex")).toBe(result.sha256);
				const saved = reopened.snapshot().tasks["saved-worker"].attempts["0"].result;
				if (!saved) throw new Error("Saved terminal payload was not reassembled");
				const savedBytes = await fs.readFile(path.join(path.dirname(file), "blobs", saved.sha256));
				expect(JSON.parse(savedBytes.toString())).toEqual({ value: 42 });
				expect(new Bun.SHA256().update(savedBytes).digest("hex")).toBe(saved.sha256);
			} finally {
				await reopened.close();
			}
		});
	});

	it("legacy unknown IDs and ambiguous names never gain dispatch ownership", async () => {
		const commands = importLegacyAttemptJournal({
			leadSessionId: "lead",
			todoPhases: [
				{
					name: "phase",
					tasks: [
						{
							content: "same",
							schedule: { attemptHistory: [{ workerName: "same", startedAt: 1, terminalStatus: "aborted" }] },
						},
						{
							content: "same",
							schedule: { attemptHistory: [{ workerName: "same", startedAt: 2, terminalStatus: "aborted" }] },
						},
					],
				},
			],
			entries: [
				{
					type: "custom",
					id: "unknown-receipt",
					customType: "subagent_restart_receipt",
					data: { version: 1, outcome: "idle-restored" },
				},
			],
		});
		await withJournal(async journal => {
			for (const command of commands) await journal.append(command);
			const tasks = Object.values(journal.snapshot().tasks);
			expect(tasks).toHaveLength(3);
			for (const task of tasks) {
				expect(task.taskId).not.toBe("same");
				expect(task.attempts["0"].owner).toBeNull();
				expect(task.attempts["0"].state).not.toBe("succeeded");
			}
		});
	});

	it("adoption selects retained terminal evidence and fences pre-adoption producers", async () => {
		await withJournal(async journal => {
			const data = "retained terminal bytes";
			const sha256 = new Bun.SHA256().update(data).digest("hex");
			const result = {
				artifactUri: `data:text/plain,${encodeURIComponent(data)}`,
				sha256,
				mediaType: "text/plain",
				executionOutcome: "success" as const,
			};
			const source = { fingerprint: "conflict", entryIds: ["first", "second"], conflicts: [result] };
			await journal.append(
				taskCommand("LegacyImported", { commandId: "unresolved", state: "legacy-unresolved", source }),
			);
			const stale = cas(journal);
			const foreignData = "not retained evidence";
			const foreignResult = {
				...result,
				artifactUri: `data:text/plain,${encodeURIComponent(foreignData)}`,
				sha256: new Bun.SHA256().update(foreignData).digest("hex"),
			};
			await expect(
				journal.append(
					taskCommand("LegacyAdopted", {
						commandId: "wrong-evidence",
						state: "succeeded",
						generation: 2,
						owner: { ...owner, leaseEpoch: 2 },
						...cas(journal),
						source,
						result: foreignResult,
						artifact: { data: foreignData, mediaType: "text/plain" },
					}),
				),
			).rejects.toThrow();
			for (const overrides of [
				{ generation: 1 },
				{ owner },
				{ source: { ...source, fingerprint: "foreign" } },
				{ source: { ...source, entryIds: ["foreign"] } },
			])
				await expect(
					journal.append(
						taskCommand("LegacyAdopted", {
							commandId: "invalid-adoption",
							state: "succeeded",
							generation: 2,
							owner: { ...owner, leaseEpoch: 2 },
							...cas(journal),
							source,
							result,
							artifact: { data, mediaType: "text/plain" },
							...overrides,
						}),
					),
				).rejects.toThrow();
			await journal.append(
				taskCommand("LegacyAdopted", {
					commandId: "selected",
					state: "succeeded",
					generation: 2,
					owner: { ...owner, leaseEpoch: 2 },
					...cas(journal),
					source,
					result,
					artifact: { data, mediaType: "text/plain" },
				}),
			);
			await expect(
				journal.append(taskCommand("AttemptAborted", { commandId: "old-producer", state: "aborted", ...stale })),
			).rejects.toThrow();
			expect(journal.snapshot().tasks["task-1"].attempts["1"]).toMatchObject({
				state: "succeeded",
				generation: 2,
				result: { sha256 },
			});
		});
	});

	it("renaming a row preserves its proven identity and current work selection", async () => {
		const snapshot = (content: string) => ({
			leadSessionId: "lead",
			todoPhases: [
				{
					name: "phase",
					tasks: [
						{ id: "stable-row", content, schedule: { executor: { workerId: "stable-worker", startedAt: 10 } } },
					],
				},
			],
		});
		const projections: Array<AttemptJournalAttempt | undefined> = [];
		for (const name of ["before rename", "after rename"])
			await withJournal(async journal => {
				for (const command of importLegacyAttemptJournal(snapshot(name))) await journal.append(command);
				projections.push(getAttemptJournalAssignment(journal.snapshot(), "stable-row"));
			});
		// A start timestamp identifies the attempt but does not prove its current state.
		expect(projections[0]).toMatchObject({ taskId: "stable-worker:10", rowId: "stable-row", state: "unknown" });
		expect(projections[1]).toMatchObject({ taskId: "stable-worker:10", rowId: "stable-row", state: "unknown" });
	});

	it("unknown imported restart cannot be promoted by normal transitions", async () => {
		await withJournal(async journal => {
			await journal.append({
				kind: "LegacyRestartImported",
				commandId: "unknown",
				requestId: "unknown",
				state: "unknown",
				affectedAttempts: [],
				source: { fingerprint: "unknown", entryIds: ["entry"] },
			});
			for (const state of ["queued", "draining", "ready", "restoring", "completed", "failed", "cancelled"] as const)
				await expect(
					journal.append({
						kind: "RestartTransition",
						commandId: `try-${state}`,
						requestId: "unknown",
						state,
						affectedAttempts: [],
						reason: "explicit reason",
					}),
				).rejects.toThrow("illegal restart transition");
			expect(journal.snapshot().restarts.unknown.state).toBe("unknown");
		});
	});

	it("invalid artifact bytes never commit a terminal result", async () => {
		await withJournal(async journal => {
			await running(journal);
			const command = resultCommand(journal, "valid");
			if (command.kind !== "ResultCommitted" || !command.artifact)
				throw new Error("Expected result command with bytes");
			const before = journal.snapshot();
			for (const artifact of [
				undefined,
				{ data: "corrupt", mediaType: "text/plain" },
				{ data: command.artifact.data, mediaType: "application/json" },
			]) {
				await expect(journal.append({ ...command, artifact })).rejects.toThrow();
				expect(journal.snapshot()).toEqual(before);
			}
			await journal.append(command);
			expect(journal.snapshot().tasks["task-1"].attempts["1"].state).toBe("succeeded");
		});
	});

	it("ordinary transcript payloads do not invent tasks but malformed handoffs retain unknown evidence", async () => {
		await withJournal(async journal => {
			const entries = [
				{
					type: "message",
					id: "message",
					message: { role: "assistant", content: [{ type: "text", text: "ordinary transcript" }] },
				},
				{ type: "custom", id: "other", customType: "unrelated", data: {} },
			];
			for (const command of importLegacyAttemptJournal({ leadSessionId: "lead", entries }))
				await journal.append(command);
			expect(journal.snapshot().tasks).toEqual({});
		});
		await withJournal(async journal => {
			for (const command of importLegacyAttemptJournal({
				leadSessionId: "lead",
				entries: [
					{
						type: "custom",
						id: "malformed-handoff",
						customType: "subagent_restart_handoff",
						data: { version: 1 },
					},
				],
			}))
				await journal.append(command);
			const tasks = Object.values(journal.snapshot().tasks);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].attempts["0"]).toMatchObject({
				state: "unknown",
				owner: null,
				source: { entryIds: ["malformed-handoff"] },
			});
		});
	});
	it("conflicting artifacts require selecting a matching terminal result during adoption", async () => {
		const artifact = (id: string, data: string, executionOutcome: "success" | "failure") => ({
			id,
			workerId: "conflict-worker",
			data,
			artifactUri: `data:text/plain,${data}`,
			sha256: new Bun.SHA256().update(data).digest("hex"),
			mediaType: "text/plain",
			executionOutcome,
		});
		const artifacts = [artifact("one", "first", "success"), artifact("two", "second", "failure")];
		await withJournal(async journal => {
			for (const command of importLegacyAttemptJournal({ leadSessionId: "lead", artifacts }))
				await journal.append(command);
			const imported = journal.snapshot().tasks["conflict-worker"].attempts["0"];
			expect(imported.state).toBe("legacy-unresolved");
			if (!imported.source) throw new Error("Missing conflict evidence");
			const adopt = (state: string, extra: Record<string, unknown> = {}) =>
				taskCommand("LegacyAdopted", {
					commandId: `adopt-${state}-${Object.keys(extra).join("-")}`,
					taskId: "conflict-worker",
					rowId: undefined,
					attempt: 0,
					state,
					generation: 1,
					owner: { ...owner, leaseEpoch: 1 },
					source: imported.source,
					expectedRevision: 1,
					expectedAttempt: 0,
					expectedGeneration: 0,
					expectedLeaseEpoch: 0,
					...extra,
				});
			const before = journal.snapshot();
			for (const state of ["queued", "running", "aborted", "cancelled"]) {
				await expect(journal.append(adopt(state))).rejects.toThrow();
				expect(journal.snapshot()).toEqual(before);
			}
			await expect(journal.append(adopt("queued", { checkpoint: "child.jsonl" }))).rejects.toThrow();
			expect(journal.snapshot()).toEqual(before);
			const selected = {
				artifactUri: artifacts[0].artifactUri,
				sha256: artifacts[0].sha256,
				mediaType: "text/plain",
				executionOutcome: "success",
			};
			await expect(
				journal.append(adopt("failed", { result: selected, artifact: { data: "first", mediaType: "text/plain" } })),
			).rejects.toThrow();
			expect(journal.snapshot()).toEqual(before);
			const foreign = {
				...selected,
				sha256: new Bun.SHA256().update("foreign").digest("hex"),
				artifactUri: "data:text/plain,foreign",
			};
			await expect(
				journal.append(
					adopt("succeeded", { result: foreign, artifact: { data: "foreign", mediaType: "text/plain" } }),
				),
			).rejects.toThrow();
			expect(journal.snapshot()).toEqual(before);
			await journal.append(
				adopt("succeeded", { result: selected, artifact: { data: "first", mediaType: "text/plain" } }),
			);
			expect(journal.snapshot().tasks["conflict-worker"].attempts["0"]).toMatchObject({
				state: "succeeded",
				result: selected,
			});
		});
	});

	it("old custody changes cannot replace newer released work", async () => {
		for (const replacement of [null, { ...owner, workerId: "old-replacement", leaseEpoch: 2 }]) {
			await withJournal(async journal => {
				await journal.append(taskCommand("AttemptQueued"));
				await journal.append(taskCommand("AttemptAborted", { state: "aborted", ...cas(journal) }));
				await journal.append(
					taskCommand("AttemptQueued", {
						commandId: "new-work",
						taskId: "new-task",
						owner: { ...owner, workerId: "new-worker" },
						expectedRowRevision: journal.snapshot().rows["row-1"].revision,
					}),
				);
				const newTask = journal.snapshot().tasks["new-task"];
				await journal.append(
					taskCommand("OwnerTransferred", {
						commandId: "new-release",
						taskId: "new-task",
						owner: null,
						expectedRevision: newTask.revision,
						expectedAttempt: 1,
						expectedGeneration: 1,
						expectedLeaseEpoch: 1,
						expectedRowRevision: journal.snapshot().rows["row-1"].revision,
					}),
				);
				const row = journal.snapshot().rows["row-1"];
				await journal.append(
					taskCommand("OwnerTransferred", {
						commandId: "old-transfer",
						state: "aborted",
						owner: replacement,
						...cas(journal),
					}),
				);
				expect(journal.snapshot().rows["row-1"]).toEqual(row);
				expect(getAttemptJournalAssignment(journal.snapshot(), "row-1")).toMatchObject({
					taskId: "new-task",
					state: "queued",
					owner: null,
				});
				expect(journal.snapshot().tasks["task-1"].attempts["1"].owner).toEqual(replacement);
			});
		}
	});

	it("batched children retain distinct identities and import idempotently", async () => {
		const snapshot = {
			leadSessionId: "lead",
			children: [
				{ id: "child-a", toolCallId: "batch-call", entries: [] },
				{ id: "child-b", toolCallId: "batch-call", entries: [] },
			],
		};
		await withJournal(async journal => {
			const commands = importLegacyAttemptJournal(snapshot);
			const sequences = [];
			for (const command of commands) sequences.push((await journal.append(command)).seq);
			const before = journal.snapshot();
			expect(
				Object.values(before.tasks)
					.map(task => task.attempts["0"].source?.entryIds)
					.sort(),
			).toEqual([["child-a"], ["child-b"]]);
			expect(commands.at(-1)?.kind).toBe("ImportCompleted");
			expect(before.imports).toHaveLength(1);
			for (const [index, command] of importLegacyAttemptJournal(snapshot).entries())
				expect((await journal.append(command)).seq).toBe(sequences[index]);
			expect(journal.snapshot()).toEqual(before);
		});
	});

	it("only known audit profiles preserve the completed producer assignment", async () => {
		for (const agentProfile of ["qa-auditor", "reviewer", "constructor"]) {
			const audit = agentProfile !== "constructor";
			const data = "producer result";
			const snapshot = {
				leadSessionId: "lead",
				todoPhases: [
					{
						name: "phase",
						tasks: [
							{
								id: "row-1",
								schedule: {
									attemptHistory: [
										{
											attemptId: "producer:1",
											workerName: "producer",
											startedAt: 1,
											terminalStatus: "completed",
										},
									],
									executor: { workerId: "audit-worker", agentProfile, startedAt: 2 },
								},
							},
						],
					},
				],
				artifacts: [
					{
						id: "result",
						workerId: "producer",
						data,
						artifactUri: `data:text/plain,${data}`,
						sha256: new Bun.SHA256().update(data).digest("hex"),
						mediaType: "text/plain",
						executionOutcome: "success" as const,
					},
				],
			};
			await withJournal(async journal => {
				for (const command of importLegacyAttemptJournal(snapshot)) await journal.append(command);
				const assignment = getAttemptJournalAssignment(journal.snapshot(), "row-1");
				if (audit) {
					expect(assignment).toMatchObject({
						taskId: "producer:1",
						state: "succeeded",
						result: { sha256: snapshot.artifacts[0].sha256 },
					});
				} else {
					expect(assignment).toMatchObject({ taskId: "audit-worker:2", state: "unknown", purpose: "work" });
					expect(assignment?.result).toBeUndefined();
				}
				expect(journal.snapshot().tasks["audit-worker:2"].attempts["0"]).toMatchObject({
					rowId: "row-1",
					purpose: audit ? "audit" : "work",
				});
			});
		}
	});

	it("incomplete strict saved yield retains evidence without inventing success", async () => {
		const entries: JsonValue[] = [
			{
				type: "session_init",
				id: "init",
				outputSchema: {
					type: "object",
					properties: { a: { type: "string" }, b: { type: "string" } },
					required: ["a", "b"],
					additionalProperties: false,
				},
			},
			{
				type: "message",
				id: "call",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "yield-call", name: "yield", arguments: { type: ["a"], data: "value" } },
					],
				},
			},
			{
				type: "message",
				id: "result",
				message: {
					role: "toolResult",
					toolCallId: "yield-call",
					isError: false,
					details: { status: "success", type: ["a"], data: "value", complete: true },
				},
			},
		];
		await withJournal(async journal => {
			for (const command of importLegacyAttemptJournal({
				leadSessionId: "lead",
				children: [{ id: "saved-child", entries }],
			}))
				await journal.append(command);
			const attempt = journal.snapshot().tasks["saved-child"].attempts["0"];
			expect(attempt.state).toBe("unknown");
			expect(attempt.result).toBeUndefined();
			expect(attempt.source?.evidence).toEqual([{ id: "saved-child", entries }]);
		});
	});
});
