import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";

/**
 * Regression coverage for TodoTracker.#clonePhases: set/get must preserve blocker,
 * details, notes, and scheduling metadata while detaching every nested array/object.
 * Exercise the real AgentSession API and confirm its recovered schedule still
 * produces a dependency-respecting forecast.
 */
describe("AgentSession todo defensive clone", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory();

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": true, "todo.reminders": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
	});

	it("deep-preserves schedules/details/notes through real set/get and forecast reads", () => {
		const original: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{
						content: "Blocked external prerequisite",
						status: "blocked",
						blocker: "waiting on sign-off",
						details: "Keep blocker context",
						notes: ["owner requested review"],
						schedule: {
							dependencies: [],
							owner: "blocked-owner",
							resources: ["cpu"],
							estimate: {
								optimisticSeconds: 10,
								likelySeconds: 20,
								pessimisticSeconds: 30,
								confidence: "medium",
								basis: "One small follow-up after approval",
								updatedAt: 100,
							},
							progress: { at: 120, evidence: "Approval is still pending" },
							startedAt: 80,
						},
					},
					{
						content: "Completed prerequisite",
						status: "completed",
						schedule: {
							dependencies: [],
							estimate: {
								optimisticSeconds: 10,
								likelySeconds: 20,
								pessimisticSeconds: 30,
								confidence: "high",
								basis: "Completed bounded prerequisite",
								updatedAt: 100,
							},
							finishedAt: 200,
						},
					},
					{
						content: "Dependent follow-up",
						status: "pending",
						schedule: {
							dependencies: ["Completed prerequisite"],
							estimate: {
								optimisticSeconds: 10,
								likelySeconds: 20,
								pessimisticSeconds: 30,
								confidence: "medium",
								basis: "One dependent follow-up",
								updatedAt: 100,
							},
						},
					},
				],
			},
		];
		const callerInput = structuredClone(original);
		session.setTodoPhases(callerInput);
		callerInput[0]!.tasks[0]!.notes?.push("mutated after set");
		callerInput[0]!.tasks[0]!.schedule?.dependencies?.push("mutated after set");

		const afterSet = session.getTodoPhases();
		expect(afterSet).toEqual(original);
		const blocked = afterSet[0]?.tasks[0];
		expect(blocked?.status).toBe("blocked");
		expect(blocked?.blocker).toBe("waiting on sign-off");
		expect(blocked).toMatchObject({
			details: "Keep blocker context",
			notes: ["owner requested review"],
			schedule: {
				owner: "blocked-owner",
				dependencies: [],
				resources: ["cpu"],
				estimate: { basis: "One small follow-up after approval", updatedAt: 100 },
				progress: { at: 120, evidence: "Approval is still pending" },
				startedAt: 80,
			},
		});

		const returned = session.getTodoPhases();
		const external = returned[0]?.tasks[0];
		if (
			!external?.notes ||
			!external.schedule?.dependencies ||
			!external.schedule.estimate ||
			!external.schedule.progress
		) {
			throw new Error("Expected nested TODO metadata on the real session API result");
		}
		external.notes.push("mutated after get");
		external.schedule.dependencies.push("mutated after get");
		external.schedule.resources?.push("mutated after get");
		external.schedule.estimate.basis = "mutated after get";
		external.schedule.progress.evidence = "mutated after get";
		expect(session.getTodoPhases()).toEqual(original);
		expect(session.getTodoPhases()[0]?.tasks[0]?.blocker).toBe("waiting on sign-off");
		expect(session.getTodoPhases()[0]?.tasks[1]?.status).toBe("completed");

		const forecast = forecastTodoPlan(session.getTodoPhases(), { now: 300 });
		const prerequisite = forecast.rows.find(row => row.content === "Completed prerequisite");
		const dependent = forecast.rows.find(row => row.content === "Dependent follow-up");
		if (prerequisite?.earliestFinish === undefined || dependent?.earliestStart === undefined) {
			throw new Error("Expected scheduled dependency dates after the real session round-trip");
		}
		expect(dependent.earliestStart).toBeGreaterThanOrEqual(prerequisite.earliestFinish);
	});
});
