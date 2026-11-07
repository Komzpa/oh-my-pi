import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readImageMetadata } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

export const VISION_REFUSAL =
	"Your model cannot see images; hand this visual check to ui-coder via your lead (write agent://Main).";

function textOnlyWorker(ctx: ExtensionContext): boolean {
	// ctx.model is the current resolved registry model, including any live fallback.
	return ctx.agent?.kind === "sub" && ctx.model !== undefined && !ctx.model.input.includes("image");
}

export async function visionToolRefusal(event: { toolName: string; input?: unknown }, ctx: ExtensionContext) {
	if (!textOnlyWorker(ctx)) return;
	const input = (event.input ?? {}) as Record<string, unknown>;
	if (event.toolName === "read") {
		const targets = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])];
		for (const target of targets) {
			if (typeof target !== "string" || target.includes("://")) continue;
			try {
				if (await readImageMetadata(path.resolve(ctx.cwd, target))) return { block: true, reason: VISION_REFUSAL };
			} catch {
				/* The read tool owns missing-file errors. */
			}
		}
	}
	// Structured browser calls expose the method before execution. Arbitrary JS captures
	// are checked from their actual screenshot result below, never from source prose.
	if (
		event.toolName === "browser" &&
		Array.isArray(input.chain) &&
		input.chain.some(
			step =>
				step &&
				typeof step === "object" &&
				["screenshot", "tab.screenshot", "page.screenshot"].includes(step.method),
		)
	)
		return { block: true, reason: VISION_REFUSAL };
}

export function visionResultRefusal(event: { content?: unknown; details?: unknown }, ctx: ExtensionContext) {
	if (!textOnlyWorker(ctx)) return;
	const details = event.details as { screenshots?: unknown[] } | undefined;
	const image = Array.isArray(event.content) && event.content.some(part => part?.type === "image");
	if (!image && !details?.screenshots?.length) return;
	return { isError: true, content: [{ type: "text" as const, text: VISION_REFUSAL, harnessNotice: true as const }] };
}
