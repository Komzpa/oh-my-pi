import { beforeAll, expect, it } from "bun:test";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
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

// The first-task title must not remain after work reaches the final phase.
it("renders the current phase and follows goal changes in ANSI and native status", () => {
	let phase = "Final handoff";
	let objective = "All open rows done";
	let active = true;
	const ctx = createContext({
		session: {
			sessionManager: { getSessionName: () => "Create feature branch" },
			getTodoPhases: () => [{ name: phase, tasks: [{ status: active ? "in_progress" : "completed" }] }],
			getGoalModeState: () => ({ goal: { status: "active", objective, tokensUsed: 0 } }),
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
	expect(shown()).toBe("Create feature branch");
});

it("falls through an empty active phase to the goal and saved session title", () => {
	const ctx = createContext({
		session: {
			sessionManager: { getSessionName: () => "Saved session" },
			getTodoPhases: () => [{ name: " \t", tasks: [{ status: "in_progress" }] }],
			getGoalModeState: () => ({ goal: { status: "active", objective: "Current goal" } }),
		} as unknown as SegmentContext["session"],
	});
	expect(Bun.stripANSI(renderSegment("session_name", ctx).content)).toBe("Current goal");
	expect(
		describeSegment("session_name", ctx)
			?.spans.map(part => part.t)
			.join(""),
	).toBe("Current goal");
	ctx.session.getGoalModeState = () => undefined;
	expect(Bun.stripANSI(renderSegment("session_name", ctx).content)).toBe("Saved session");
});

it("invalidates the ANSI component cache and refreshes native preview titles as work changes", () => {
	let phase = "Implementation";
	let active = true;
	let objective = "Ship feature";
	const session: StatusLineSession = {
		state: { messages: [] },
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => "Saved title",
			getSessionId: () => "",
			getUsageStatistics: () => createContext().usageStats,
		},
		modelRegistry: { isUsingSubscription: () => false },
		getContextUsage: () => undefined,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getTodoPhases: () => [{ name: phase, tasks: [{ status: active ? "in_progress" : "completed" }] }],
		getGoalModeState: () => ({ goal: { status: "active", objective, tokensUsed: 0 } }),
	};
	const host: StatusLineHost = {
		getSettings: () => ({ preset: "custom", leftSegments: ["session_name"], rightSegments: [] }),
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: async () => null,
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	};
	const component = new StatusLineComponent(session, host);
	try {
		const checkTitle = (title: string) => {
			expect(Bun.stripANSI(component.renderBottomBar(160, "full"))).toContain(title);
			expect(JSON.stringify(component.describePreview())).toContain(title);
			// Composer facts omit the session title: the native pane owns that display.
			expect(JSON.stringify(component.describeComposerFacts().extras)).not.toContain(title);
		};
		checkTitle("Implementation");
		phase = "Verification";
		checkTitle("Verification");
		active = false;
		checkTitle("Ship feature");
		objective = "Publish feature";
		checkTitle("Publish feature");
	} finally {
		component.dispose();
	}
});

it("reads a live snapshot for frame titles without copying an unchanged plan", () => {
	let inspections = 0;
	let phases = [
		{
			name: "Implementation",
			tasks: [
				{
					get status() {
						inspections++;
						return "in_progress";
					},
				},
			],
		},
	];
	let copies = 0;
	const session = {
		getTodoSnapshot: () => phases,
		getTodoPhases: () => {
			copies++;
			return structuredClone(phases);
		},
		getGoalModeState: () => undefined,
	} as unknown as StatusLineSession;
	const context = createContext({ session });
	for (let frame = 0; frame < 100; frame++)
		expect(Bun.stripANSI(renderSegment("session_name", context).content)).toBe("Implementation");
	expect(copies).toBe(0);
	expect(inspections).toBe(1);
	phases = [{ name: "Verification", tasks: [{ status: "in_progress" }] }];
	expect(Bun.stripANSI(renderSegment("session_name", context).content)).toBe("Verification");
	expect(copies).toBe(0);
});
