import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { answersWorkerQuestion, pendingWorkerAsks, type WorkerQuestion } from "@oh-my-pi/pi-coding-agent/task/worker-questions";
import { prompt } from "@oh-my-pi/pi-utils";
import brief from "./worker-ask.md" with { type: "text" };

export function pendingWorkerQuestions(ctx: ExtensionContext): Array<WorkerQuestion & { worker: string }> {
	const jobs = ctx.getAsyncJobSnapshot?.();
	const seen = new Set<string>();
	return [...(jobs?.running ?? []), ...(jobs?.recent ?? [])].flatMap(job => {
		const worker = job.agentId ?? job.id;
		if (job.type !== "task" || seen.has(worker)) return [];
		seen.add(worker);
		return pendingWorkerAsks(AgentRegistry.global().get(worker)?.session?.messages ?? []).map(q => ({
			...q,
			worker,
		}));
	});
}

/** Questions are a separate obligation: unrelated dispatcher progress cannot discharge them. */
export function installWorkerAskInterrupt(pi: ExtensionAPI): void {
	const answered = new Set<string>();
	let announced = "";
	let timer: Timer | undefined;
	const key = (q: WorkerQuestion & { worker: string }) => JSON.stringify([q.worker, q.id, q.questionId]);
	const pending = (ctx: ExtensionContext) => pendingWorkerQuestions(ctx).filter(q => !answered.has(key(q)));
	const main = (ctx: ExtensionContext) => !ctx.sessionManager.getHeader()?.parentSession;
	const notify = (ctx: ExtensionContext, force = false) => {
		if (!main(ctx)) return;
		const questions = pending(ctx);
		const stamp = JSON.stringify(questions);
		if (!questions.length) {
			announced = "";
			return;
		}
		if (!force && stamp === announced) return;
		announced = stamp;
		pi.sendMessage(
			{
				customType: "worker-ask-interrupt",
				content: prompt.render(brief, { questions }),
				display: true,
				details: { questions, supersedesQueued: true },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};
	pi.on("tool_result", (event, ctx) => {
		if (!main(ctx)) return;
		if (!event.isError && event.toolName === "write") {
			const input = event.input as { path?: string; content?: string };
			for (const q of pending(ctx))
				if (
					input?.path === `agent://${q.worker}` &&
					(q.questionId === "reply"
						? Boolean(input.content?.trim())
						: answersWorkerQuestion(input.content ?? "", q))
				)
					answered.add(key(q));
		}
		notify(ctx);
	});
	pi.on("tool_call", (event, ctx) => {
		if (!main(ctx) || !["wait", "yield"].includes(event.toolName)) return;
		const questions = pending(ctx);
		if (questions.length) return { block: true, reason: prompt.render(brief, { questions }) };
	});
	pi.on("turn_end", (_event, ctx) => notify(ctx, true));
	pi.on("before_agent_start", (_event, ctx) => notify(ctx));
	pi.on("context", (event, ctx) => {
		if (!main(ctx)) return;
		const questions = pending(ctx);
		if (!questions.length) return;
		// Most recent input is consumed last, ahead of synthetic dispatcher/time notices.
		return {
			messages: [
				...event.messages.filter(m => !(m.role === "custom" && m.customType === "worker-ask-interrupt")),
				{
					role: "custom",
					customType: "worker-ask-interrupt",
					content: prompt.render(brief, { questions }),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) ctx.clearTimer(timer);
	});
	pi.on("session_start", (_event, ctx) => {
		answered.clear();
		announced = "";
		if (timer) ctx.clearTimer(timer);
		if (main(ctx)) timer = ctx.setInterval(() => notify(ctx), 1000);
	});
}
