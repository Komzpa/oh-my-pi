import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import changedTemplate from "../prompts/system/instruction-file-changed.md" with { type: "text" };
import type { SessionManager } from "./session-manager";

const ENTRY_TYPE = "instruction-file-version";

export function isInstructionFilePath(filePath: string): boolean {
	const name = path.basename(filePath).toLowerCase();
	return name === "skill.md" || name === "agents.md" || name === "agents.override.md";
}

interface InstructionVersion {
	path: string;
	body: string;
	hash: string;
	mtimeMs?: number;
	size?: number;
	notices?: string[];
}

/** Session-local loaded versions, restored from the active journal branch. */
export class InstructionFiles {
	#versions = new Map<string, InstructionVersion>();
	#sessionId = "";
	constructor(readonly manager: SessionManager) {}

	#sync(): void {
		const id = this.manager.getSessionId();
		if (id === this.#sessionId) return;
		this.#sessionId = id;
		this.#versions.clear();
		for (const entry of this.manager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const version = entry.data as InstructionVersion;
			if (
				typeof version?.path === "string" &&
				typeof version.body === "string" &&
				typeof version.hash === "string"
			) {
				// A restarted process must stat/hash again, even if timestamps were preserved.
				this.#versions.set(version.path, { ...version, mtimeMs: undefined });
			}
		}
	}

	/** Record bytes actually loaded, never skill catalog descriptions. */
	async loaded(filePath: string, body?: string, onlyIfAbsent = false): Promise<void> {
		this.#sync();
		const absolute = path.resolve(this.manager.getCwd(), filePath);
		if (onlyIfAbsent && this.#versions.has(absolute)) return;
		try {
			const file = Bun.file(absolute);
			const stat = await file.stat();
			const text = body ?? (await file.text());
			const version: InstructionVersion = {
				path: absolute,
				body: text,
				hash: Bun.SHA256.hash(text, "hex"),
				// Provided text may have been read before stat; force the first comparison.
				mtimeMs: body === undefined ? stat.mtimeMs : undefined,
				size: stat.size,
			};
			if (this.#versions.get(absolute)?.hash === version.hash) return;
			this.manager.appendCustomEntry(ENTRY_TYPE, version);
			this.#versions.set(absolute, version);
		} catch (error) {
			if (!isEnoent(error)) logger.warn("Instruction file tracking failed", { path: absolute, error });
		}
	}

	async loadedInstruction(filePath: string, body?: string): Promise<void> {
		if (isInstructionFilePath(filePath)) await this.loaded(filePath, body);
	}

	/** Commit one notice per content transition. Stat-only when the file has not changed. */
	async refresh(maxBytes: number): Promise<string[]> {
		this.#sync();
		const notices: string[] = [];
		for (const [filePath, previous] of this.#versions) {
			try {
				const file = Bun.file(filePath);
				const stat = await file.stat();
				if (previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue;
				const body = await file.text();
				const hash = Bun.SHA256.hash(body, "hex");
				if (hash === previous.hash) {
					previous.mtimeMs = stat.mtimeMs;
					previous.size = stat.size;
					continue;
				}
				const notice = prompt.compile(changedTemplate)({
					path: filePath,
					body:
						Buffer.byteLength(body) <= maxBytes
							? body
							: createTwoFilesPatch(filePath, filePath, previous.body, body),
				});
				const version: InstructionVersion = {
					path: filePath,
					body,
					hash,
					mtimeMs: stat.mtimeMs,
					size: stat.size,
					notices: [...(Buffer.byteLength(body) > maxBytes ? (previous.notices ?? []) : []), notice],
				};
				this.manager.appendCustomEntry(ENTRY_TYPE, version);
				this.#versions.set(filePath, version);
				notices.push(notice);
			} catch (error) {
				if (!isEnoent(error)) logger.warn("Instruction file refresh failed", { path: filePath, error });
			}
		}
		return notices;
	}

	/** Latest superseding instructions remain in the system prompt across rebuilds/resume. */
	systemNotices(): string[] {
		this.#sync();
		return [...this.#versions.values()].flatMap(version => version.notices ?? []);
	}
}
