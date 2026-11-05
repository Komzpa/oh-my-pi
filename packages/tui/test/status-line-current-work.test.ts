import { beforeAll, expect, it } from "bun:test";
import { describeSegment, renderSegment, type SegmentContext } from "../src/status-line/segments";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function createContext(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		session: {} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	};
}

// Session 01a1921c: the first-task title remained after work reached Final handoff.
it("renders the current phase and follows goal changes in ANSI and native status", () => {
	let phase = "Final handoff";
	let objective = "All open rows done";
	let active = true;
	const ctx = createContext({
		session: {
			sessionManager: { getSessionName: () => "DC: Create datacenter work branch" },
			getTodoPhases: () => [{ name: phase, tasks: [{ status: active ? "in_progress" : "completed" }] }],
			getGoalModeState: () => ({ goal: { status: "active", objective } }),
		} as unknown as SegmentContext["session"],
	});
	const shown = () => Bun.stripANSI(renderSegment("session_name", ctx).content);
	expect(shown()).toBe("Final handoff");
	phase = "Follow-ups";
	expect(shown()).toBe("Follow-ups");
	expect(
		describeSegment("session_name", ctx)
			?.spans.map(part => part.t)
			.join(""),
	).toBe("Follow-ups");
	active = false;
	expect(shown()).toBe("All open rows done");
	objective = "Publish the review page";
	expect(shown()).toBe("Publish the review page");
	ctx.session.getGoalModeState = () => undefined;
	expect(shown()).toBe("DC: Create datacenter work branch");
});
