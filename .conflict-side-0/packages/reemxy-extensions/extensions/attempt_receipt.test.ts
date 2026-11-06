// @ts-nocheck -- durable row receipt fixture.
import { expect, test } from "bun:test";
import { prepareAttemptBrief } from "./attempt_receipt";

test("redispatch selects latest attempt by finish time and carries existing fix, failed oracle and open question", () => {
	const row = {
		content: "PushFitCamera",
		blocker: "Which camera target?",
		schedule: {
			attemptHistory: [
				{
					attemptId: "new",
					workerName: "PushFitCamera-10",
					terminalStatus: "failed",
					finishedAt: 20,
					finalReportParagraph: "Fix and oracle exist on cae9987d0; browser proof failed",
					gitCommits: [{ commit: "cae9987d0", repoPath: "/project" }],
					deliverablePaths: ["proof/camera.png"],
					rejectionReason: "camera fit clipped",
				},
				{ attemptId: "old", workerName: "PushFitCamera-9", finishedAt: 10, finalReportParagraph: "No fix exists" },
			],
		},
	};
	const brief = prepareAttemptBrief(row, "PushFitCamera: fix and oracle missing");
	expect(brief.refusal).toBeUndefined();
	expect(brief.task).toContain("cae9987d0");
	expect(brief.task).toContain("camera fit clipped");
	expect(brief.task).toContain("Which camera target?");
	expect(brief.task).not.toContain('"attempt": "old"');
	expect(prepareAttemptBrief({ content: "Other", schedule: {} }, "new work")).toEqual({ task: "new work" });
});

test("redispatch refuses missing findings instead of running with stale premises", () => {
	const row = { content: "PushFitCamera", schedule: { executor: { workerId: "previous", finishedAt: 10 } } };
	expect(prepareAttemptBrief(row, "retry").refusal).toContain("no previous attempt findings");
	row.schedule.progress = { evidence: "Existing oracle works; missing browser screenshot" };
	expect(prepareAttemptBrief(row, "retry").task).toContain("missing browser screenshot");
});
