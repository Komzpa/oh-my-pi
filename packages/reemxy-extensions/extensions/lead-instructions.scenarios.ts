import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { convertWithHarnessNotices } from "../../coding-agent/src/session/harness-notices";
import { convertToLlm } from "../../coding-agent/src/session/messages";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatTodoView, getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { TodoDisplayContext, TodoDisplayState, TodoScheduleInputTask } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ReviewPageAnswer } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { workerToolPreflight } from "./dispatch_preflight";
import todoDescription from "../../coding-agent/src/prompts/tools/todo.md" with { type: "text" };
import churn from "./fixtures/dc-verify-churn.json";
import live from "./fixtures/dc-rowclose-1645.json";
import todoDispatch, { decideGateCall } from "./todo_dispatch";
import { admitAssignedResources } from "./agent_router";
import { zeroActiveGate } from "./zero-active";

export interface LeadInstructionScenario {
	decisions?: Array<{
		call: { name: string; arguments?: Record<string, unknown> };
		allowed: boolean;
		reason?: string;
	}>;
	id: string;
	context: string;
	todoDescription: string;
	expected: { tool: string; args: Record<string, unknown> } | null;
	row: string;
	state: TodoDisplayState;
	expectedState: TodoDisplayState;
	notices: string[];
	phases: TodoPhase[];
	answer?: string;
	expectedReview?: string;
}
export interface Case {
	id: string;
	row: TodoScheduleInputTask;
	state: TodoDisplayState;
	expected: LeadInstructionScenario["expected"];
	workers?: Array<{ id: string; agent?: string }>;
	context?: Partial<TodoDisplayContext>;
	userMessage?: string;
	userBlockAsked?: boolean;
	pageAnswer?: "accept" | "redo" | "drop";
	scopeRefused?: boolean;
	harnessRole?: boolean;
	extraRows?: TodoScheduleInputTask[];
	probeCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

/** Independent consumer expectation: adding a display state requires a decision here. */
export const expectedDisplayActions: Record<TodoDisplayState, "wait" | "task" | "todo" | "ask"> = {
	working: "wait",
	waiting: "wait",
	auditing: "wait",
	verifying: "wait",
	"audit queued": "wait",
	"handoff pending": "ask",
	"ready to close": "todo",
	"needs you": "wait",
	"needs worker": "task",
	stuck: "ask",
};

function cases(now: number): Case[] {
	const delivered = structuredClone(
		live.phases[0].tasks.find(row => row.content === "Power source rows: remove red selection frame and grey boxes")!,
	) as TodoScheduleInputTask;
	const findings = structuredClone(
		live.phases[0].tasks.find(row => row.content === "Mac call: attribute 30 fps drop untraced")!,
	) as TodoScheduleInputTask;
	const normalize = (row: TodoScheduleInputTask) => {
		row.schedule = {
			...row.schedule,
			dependencies: [],
			resources: [],
			estimateRevision: 1,
			reestimateCount: 0,
			startedAt: now,
			estimate: {
				optimisticSeconds: 60,
				likelySeconds: 120,
				pessimisticSeconds: 240,
				confidence: "medium",
				basis: "Fixture scope",
				updatedAt: now,
			},
		};
		return row;
	};
	normalize(delivered);
	normalize(findings);
	const change = (source: TodoScheduleInputTask, patch: Partial<TodoScheduleInputTask> = {}) => ({
		...structuredClone(source),
		...patch,
	});
	const dispatch = (row: TodoScheduleInputTask) => ({ tool: "task", args: { tasks: [{ task: row.content }] } });
	const work = change(findings);
	work.schedule!.executor = { ...work.schedule!.executor!, outcome: undefined, finishedAt: undefined };
	work.schedule!.deliveryCritic = undefined;
	const owner = work.schedule!.owner!;
	const auditedReview = change(delivered, {
		schedule: {
			...delivered.schedule,
			review: "user",
			firstDeliveredAt: now - 1000,
			reviewPage: "http://review.invalid/card",
			handoffPending: false,
			reviewPagePending: false,
		},
	});
	auditedReview.schedule!.audit = {
		agent: schedule.TODO_ROW_AUDITOR,
		delivery: schedule.todoRowDeliveryKey(auditedReview.schedule),
		repoPath: "/fixture",
		head: "abc1234",
		startedAt: now,
		verdict: "pass",
	};
	const verifying = change(delivered);
	verifying.schedule!.audit = {
		agent: schedule.TODO_ROW_AUDITOR,
		delivery: schedule.todoRowDeliveryKey(verifying.schedule),
		repoPath: "/fixture",
		head: "abc1234",
		startedAt: now,
		verdict: "pending",
		workerId: "RowAudit",
	};

	const proof = normalize(structuredClone(churn.row) as TodoScheduleInputTask);
	proof.schedule!.audit = {
		agent: schedule.TODO_ROW_AUDITOR,
		delivery: schedule.todoRowDeliveryKey(proof.schedule),
		repoPath: churn.row.artifactCwd,
		head: "f73f78a6147e1e16d26619b39ab698769e66e461",
		startedAt: now,
		verdict: "fail",
		findings: churn.row.schedule.progress.evidence,
	};
	const output: Case[] = [
		{
			id: "unseen-product-decision",
			row: change(auditedReview, {
				content: "Maksim: showcase scenario",
				schedule: { ...auditedReview.schedule, decision: "owner", handoffPending: true },
			}),
			state: "handoff pending",
			expected: { tool: "text", args: { reviewPage: "http://review.invalid/card" } },
		},
		{ id: "missing-executable-proof", row: proof, state: "needs worker", expected: dispatch(proof) },
		{ id: "working", row: work, state: "working", expected: null, workers: [{ id: owner }] },
		{
			id: "waiting",
			row: change(work, { schedule: { ...work.schedule, dependencies: ["DependencyWorker"] } }),
			state: "waiting",
			expected: null,
			workers: [{ id: "DependencyWorker" }],
		},
		{
			id: "verifying",
			row: verifying,
			state: "verifying",
			expected: null,
			workers: [{ id: "RowAudit", agent: "qa-auditor" }],
		},
		{ id: "audit-queued", row: change(delivered), state: "audit queued", expected: null },
		{
			id: "handoff-pending",
			row: change(auditedReview, { schedule: { ...auditedReview.schedule, handoffPending: true } }),
			state: "handoff pending",
			expected: { tool: "text", args: { reviewPage: "http://review.invalid/card" } },
		},
		{
			id: "auditing",
			row: change(delivered),
			state: "auditing",
			expected: null,
			workers: [{ id: "AuditWorker", agent: "qa-auditor" }],
			context: { auditors: new Map([[delivered.content, "AuditWorker"]]) },
		},
		{
			id: "ready-to-close",
			row: change(work, { schedule: { ...work.schedule, executor: undefined } }),
			state: "ready to close",
			expected: { tool: "todo", args: { op: "done", task: work.content } },
			context: {
				requirements: [
					{
						classification: "verified",
						rows: [work.content],
						rowVerdicts: { [work.content]: { status: "pass" } },
					},
				],
			},
		},
		{
			id: "needs-you",
			row: change(auditedReview),
			state: "needs you",
			expected: null,
		},
		{ id: "findings-only", row: change(findings), state: "needs worker", expected: dispatch(findings) },
	];
	for (const outcome of ["aborted", "failed", undefined] as const) {
		const row = change(findings, {
			schedule: {
				...findings.schedule,
				executor: { ...findings.schedule!.executor!, outcome, ...(outcome ? {} : { finishedAt: undefined }) },
			},
		});
		output.push({ id: outcome ?? "lost-after-restart", row, state: "needs worker", expected: dispatch(row) });
	}
	const failed = change(delivered);
	failed.schedule!.audit = {
		agent: schedule.TODO_ROW_AUDITOR,
		delivery: schedule.todoRowDeliveryKey(failed.schedule),
		repoPath: "/fixture",
		head: "abc1234",
		startedAt: now,
		verdict: "fail",
		findings: "Settings still exposes the wrong return edge",
	};
	output.push({ id: "audit-fail", row: failed, state: "needs worker", expected: dispatch(failed) });
	const moved = change(delivered);
	moved.schedule!.audit = {
		agent: schedule.TODO_ROW_AUDITOR,
		delivery: schedule.todoRowDeliveryKey(moved.schedule),
		repoPath: "/fixture",
		head: "old1234",
		startedAt: now,
		verdict: "pending",
	};
	output.push({ id: "head-moved", row: moved, state: "audit queued", expected: null });
	const late = change(work);
	late.schedule!.startedAt = now - 600_000;
	late.schedule!.estimate!.updatedAt = now - 600_000;
	output.push({
		id: "eta-reached",
		row: late,
		state: "working",
		workers: [{ id: owner }],
		expected: { tool: "todo", args: { op: "schedule", updates: [{ task: late.content }] } },
	});
	const answered = change(auditedReview);
	output.push({
		id: "user-answered-review",
		row: answered,
		state: "needs you",
		userMessage: "Accept this delivery",
		expected: { tool: "todo", args: { op: "schedule", updates: [{ task: answered.content, review: "accepted" }] } },
	});
	for (const answer of ["accept", "redo", "drop"] as const)
		output.push({
			id: `review-page-${answer}`,
			row: change(auditedReview),
			pageAnswer: answer,
			state: "needs worker",
			expected: answer === "redo" ? dispatch(auditedReview) : null,
		});
	output.push({
		id: "owner-question-telegram",
		row: change(auditedReview),
		state: "needs you",
		userMessage: `Reemxy owner_question reply via Telegram, row "${auditedReview.content}": Accept this delivery`,
		expected: {
			tool: "todo",
			args: { op: "schedule", updates: [{ task: auditedReview.content, review: "accepted" }] },
		},
	});
	output.push({
		id: "never-handed-to-owner",
		row: change(auditedReview, { schedule: { ...auditedReview.schedule, handoffPending: true } }),
		state: "handoff pending",
		expected: { tool: "text", args: { reviewPage: "http://review.invalid/card" } },
	});
	output.push({
		id: "running-worker-scope",
		row: change(work),
		state: "working",
		workers: [{ id: owner }],
		scopeRefused: true,
		expected: {
			tool: "todo",
			args: { op: "schedule", updates: [{ task: work.content }] },
		},
	});
	const blocked = change(work, {
		status: "blocked",
		blocker: "waits for user: Which endpoint? proposal: staging because production is not approved",
	});
	output.push({
		id: "blocked-on-user",
		row: blocked,
		state: "stuck",
		expected: { tool: "text", args: { row: blocked.content, subject: "endpoint", proposal: "staging" } },
	});
	output.push({
		id: "blocked-user-already-asked",
		row: change(blocked),
		state: "stuck",
		expected: null,
		userBlockAsked: true,
	});
	const refused = change(findings, {
		schedule: { ...findings.schedule, executor: { ...findings.schedule!.executor!, outcome: "failed" } },
	});
	output.push({ id: "refused", row: refused, state: "needs worker", expected: dispatch(refused) });
	const cap = change(late);
	cap.schedule!.reestimateCount = 2;
	output.push({
		id: "estimate-cap",
		row: cap,
		state: "working",
		workers: [{ id: owner }],
		expected: null,
	});
	const external = change(blocked, { blocker: "Waiting for service maintenance window" });
	output.push({ id: "external-blocker", row: external, state: "stuck", expected: null });
	const full = change(findings);
	output.push({
		id: "capacity-full",
		workers: [{ id: "UnrelatedWorker" }],
		row: full,
		state: "waiting",
		expected: null,
		context: { capacityFull: true },
	});
	return output;
}

export async function leadInstructionScenarios(): Promise<LeadInstructionScenario[]> {
	const results: LeadInstructionScenario[] = [];
	for (const item of cases(Date.now())) results.push(await capture(item));
	return results;
}

export async function capture(item: Case): Promise<LeadInstructionScenario> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-instruction-turn-"));
	try {
		let phases = [{ name: "Delivery", tasks: [structuredClone(item.row), ...structuredClone(item.extraRows ?? [])] }];
		if (item.id === "waiting")
			phases[0]!.tasks.push({
				content: "DependencyWorker",
				status: "in_progress",
				schedule: {
					...structuredClone(item.row.schedule),
					owner: "DependencyWorker",
					dependencies: [],
					executor: undefined,
				},
			});
		const manager = SessionManager.inMemory();
		const tool = new TodoTool({
			cwd,
			settings: Settings.isolated(),
			sessionManager: manager,
			getSessionFile: () => null,
			getTodoPhases: () => phases,
			setTodoPhases: (next: TodoPhase[]) => {
				phases = next;
			},
		} as unknown as ToolSession);
		let page: Bun.Server<undefined> | undefined;
		if (item.pageAnswer) {
			page = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch(request) {
					return Response.json(
						new URL(request.url).pathname.endsWith("api/answers")
							? {
									card: {
										answer: item.pageAnswer,
										expectedReview:
											item.pageAnswer === "accept" ||
											item.id === "user-answered-review" ||
											item.id === "owner-question-telegram"
												? "accepted"
												: item.pageAnswer,
										note: item.pageAnswer === "redo" ? "The switch still clips at 720 px" : "",
										content_sha: "fixture-sha",
									},
								}
							: { cards: [{ id: "card", title: item.row.content, content_sha: "fixture-sha" }] },
					);
				},
			});
			phases[0]!.tasks[0]!.schedule!.reviewPage = `http://127.0.0.1:${page.port}/review/`;
		}
		const journal: Array<Record<string, unknown>> = [];
		if (item.context?.requirements)
			journal.push({
				type: "custom",
				customType: "requirements_ledger",
				data: { requirements: item.context.requirements },
			});
		if (item.context?.auditors)
			journal.push({
				type: "custom",
				customType: "requirements_auditor_assignments",
				data: {
					jobs: [...item.context.auditors].map(([row, workerId]) => ({
						agent: "qa-auditor",
						workerId,
						rows: [row],
					})),
				},
			});
		if (item.userMessage)
			journal.push({ type: "message", message: { role: "user", content: item.userMessage, timestamp: Date.now() } });
		if (item.userBlockAsked)
			journal.push({
				type: "custom",
				customType: "todo-user-unblock",
				data: { row: item.row.content, question: "Which endpoint?", asked: true, at: Date.now() },
			});
		const messages: Array<{ customType: string; content: string; details?: unknown }> = [];
		const hooks = new Map<string, (event: never, ctx: never) => unknown>();
		const workers = item.workers ?? [];
		const owners = new Map(
			workers.filter(worker => worker.id === item.row.schedule?.owner).map(worker => [item.row.content, worker]),
		);
		const displayContext: TodoDisplayContext = { workers, owners, ...item.context };
		const api = {
			on: (name: string, hook: (event: never, ctx: never) => unknown) => hooks.set(name, hook),
			getActiveTools: () => ["todo", "task", "read", "wait"],
			appendEntry: (customType: string, data: unknown) => journal.push({ type: "custom", customType, data }),
			sendMessage: (message: { customType: string; content: string; details?: unknown }) => {
				messages.push(message);
				journal.push({ type: "custom_message", ...message, timestamp: new Date().toISOString() });
			},
			pi: {
				...schedule,
				getLatestTodoPhasesFromEntries,
				readGoalDeadline: () => undefined,
				agentPauseGate: { paused: false },
			},
			registerSoftToolRequirementProvider: () => {},
		} as unknown as ExtensionAPI;
		await todoDispatch(api, { reviewPageProbe: async () => 200, reviewPageOpener: () => {} });
		const ctx = {
			cwd,
			getTodoPreviewConfig: () => ({ enabled: false, paths: [], thresholdMinutes: 15, openReviewPages: false }),
			sessionManager: {
				getHeader: () => ({ id: `instruction-${item.id}` }),
				getLeafId: () => String(journal.length),
				getBranch: () => journal,
				getBranchMatching: (predicate: (entry: unknown) => boolean) => journal.filter(predicate),
				getLatestBranchMatching: (predicate: (entry: unknown) => boolean) => journal.findLast(predicate),
				getSessionFile: () => undefined,
			},
			getTodoPhases: () => phases,
			updateTodoSchedule: () => true,
			applyReviewPageAnswer: (answer: ReviewPageAnswer) => tool.applyReviewPageAnswer(answer),
			getAsyncJobSnapshot: () => ({
				running: workers.map(worker => ({
					...worker,
					agentId: worker.id,
					label: worker.id,
					type: "task",
					status: "running",
					startTime: Date.now(),
				})),
				recent: [],
				nonJobAgents: [],
			}),
			getTaskMaxConcurrency: () => (item.context?.capacityFull ? workers.length : 20),
			isIdle: () => false,
			hasPendingMessages: () => false,
			setTimeout: () => ({}),
			setInterval: () => ({}),
			clearInterval: () => {},
			clearTimer: () => {},
		} as unknown as ExtensionContext;
		if (item.userMessage)
			await hooks.get("message_start")!(
				{ message: { role: "user", content: item.userMessage, timestamp: Date.now() } } as never,
				ctx as never,
			);
		if (item.pageAnswer)
			await hooks.get("tool_call")?.({ toolName: "read", input: { path: "review-page" } } as never, ctx as never);
		const decisions = [];
		for (const call of item.probeCalls ?? []) {
			const result = (await hooks.get("tool_call")!(
				{ toolName: call.name, input: call.arguments, toolCallId: "probe" } as never,
				ctx as never,
			)) as { block?: boolean; reason?: string } | undefined;
			decisions.push({ call, allowed: !result?.block, reason: result?.reason });
		}
		await hooks.get("turn_end")!({} as never, ctx as never);
		const view = formatTodoView(phases as TodoPhase[], {
			now: Date.now(),
			capacity: item.context?.capacityFull ? workers.length : 20,
		});
		const viewResult = item.harnessRole
			? ((await hooks.get("tool_result")!(
					{
						toolName: "todo",
						input: { op: "view" },
						toolCallId: "visible-view",
						content: [{ type: "text", text: view }],
						isError: false,
					} as never,
					ctx as never,
				)) as { content?: unknown[] } | undefined)
			: undefined;
		const shaped = item.harnessRole
			? ((await hooks.get("context")!(
					{
						messages: [
							{
								role: "toolResult",
								toolName: "todo",
								toolCallId: "visible-view",
								content: viewResult?.content ?? [{ type: "text", text: view }],
								isError: false,
								timestamp: Date.now(),
							},
							...messages.map(message => ({
								...message,
								role: "custom",
								display: false,
								timestamp: Date.now(),
							})),
						],
					} as never,
					ctx as never,
				)) as { messages: AgentMessage[] })
			: undefined;
		const visibleNotices = shaped
			? convertWithHarnessNotices(shaped.messages, "user", convertToLlm).flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])),
				)
			: messages.map(message => message.content);
		const finalRow = phases[0]!.tasks[0]!;
		const state = schedule.classifyTodoDisplayRow(finalRow, phases, displayContext).state;
		page?.stop(true);
		await manager.close();
		const refusal = item.scopeRefused
			? await workerToolPreflight({ toolName: "write", input: { path: "/replacement-worktree/result.ts" } }, {
					cwd,
					agent: { kind: "sub", id: item.row.schedule!.owner },
				} as ExtensionContext)
			: undefined;
		return {
			id: item.id,
			decisions,
			phases: phases as TodoPhase[],
			answer: item.pageAnswer,
			expectedReview:
				item.pageAnswer === "accept" || item.id === "user-answered-review" || item.id === "owner-question-telegram"
					? "accepted"
					: item.pageAnswer,
			todoDescription,
			row: item.row.content,
			state,
			expectedState: item.state,
			expected: item.expected,
			notices: messages.map(message => message.content),
			context: [
				todoDescription,
				...(refusal
					? [
							`Worker ${item.row.schedule!.owner} on row ${JSON.stringify(item.row.content)} reports: ${refusal.reason}. The required scope is /replacement-worktree.`,
						]
					: []),
				...(item.userMessage ? [item.userMessage] : []),
				view,
				...visibleNotices,
			].join("\n\n"),
		};
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

/** Execute only native TODO decisions in disposable state; no worker/control tools run. */
export async function verifyLeadRoundTrip(
	scenario: LeadInstructionScenario,
	calls: Array<{ name: string; arguments: unknown }>,
): Promise<boolean> {
	if (scenario.decisions?.length) {
		for (const call of calls) {
			if (typeof call.arguments !== "object" || call.arguments === null) return false;
			const args = call.arguments as Record<string, unknown>;
			const matching = scenario.decisions.filter(
				decision =>
					decision.call.name === call.name &&
					decision.call.arguments?.op === args.op &&
					decision.call.arguments?.path === args.path,
			);
			if (matching.some(decision => !decision.allowed)) return false;
			if (!decideGateCall({ name: call.name, arguments: args }, [zeroActiveGate(scenario.context)]).allowed)
				return false;
			if (call.name === "task") {
				for (const item of (args.tasks ?? []) as Array<Record<string, unknown>>) {
					const ctx = {
						cwd: "/fixture",
						getTodoPhases: () => scenario.phases,
						updateTodoSchedule: () => true,
					} as unknown as ExtensionContext;
					if (admitAssignedResources(item, ctx)) return false;
				}
			}
		}
		return true;
	}
	if (
		calls.some(
			call => call.name === "ask" || (call.name === "write" && JSON.stringify(call.arguments).includes("/kill")),
		)
	)
		return false;
	if (!scenario.expectedReview && scenario.id !== "running-worker-scope") return true;
	let phases = structuredClone(scenario.phases);
	const manager = SessionManager.inMemory();
	try {
		const tool = new TodoTool({
			cwd: "/tmp",
			settings: Settings.isolated(),
			sessionManager: manager,
			getSessionFile: () => null,
			getTodoPhases: () => phases,
			setTodoPhases: (next: TodoPhase[]) => {
				phases = next;
			},
		} as unknown as ToolSession);
		for (const call of calls)
			if (call.name === "todo")
				await tool.execute("eval-answer", call.arguments as Parameters<TodoTool["execute"]>[1]);
		const row = phases.flatMap(phase => phase.tasks).find(row => row.content === scenario.row);
		if (scenario.id === "running-worker-scope")
			return (
				row?.schedule?.resources?.some(
					resource => resource === "/replacement-worktree" || resource === "/replacement-worktree/result.ts",
				) === true
			);
		return (
			!!row &&
			row.schedule?.review === scenario.expectedReview &&
			row.status ===
				(scenario.expectedReview === "accepted"
					? "completed"
					: scenario.expectedReview === "drop"
						? "abandoned"
						: "pending")
		);
	} finally {
		await manager.close();
	}
}

if (import.meta.main) {
	await Bun.write(
		Bun.argv[2] ?? "/tmp/lead-instructions-before.json",
		JSON.stringify(await leadInstructionScenarios(), null, 2),
	);
}
