import * as path from "node:path";
import { expandAtImports } from "../discovery/at-imports";
import rereadTemplate from "../prompts/system/instruction-file-reread.md" with { type: "text" };
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import changedTemplate from "../prompts/system/instruction-file-changed.md" with { type: "text" };
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

const ENTRY_TYPE = "instruction-file-version";

export function isInstructionFilePath(filePath: string): boolean {
	const name = path.basename(filePath).toLowerCase();
	return name === "skill.md" || name === "agents.md" || name === "agents.override.md";
}

interface InstructionVersion {
	path: string;
	hash: string;
	mtimeMs?: number;
	size?: number;
	notices?: string[];
}

/** Session-local loaded versions, restored from the active journal branch. */
export class InstructionFiles {
	#versions = new Map<string, InstructionVersion>();
	#sessionId = "";
	#leafId: string | null = null;
	constructor(
		readonly manager: SessionManager,
		readonly obfuscate: (text: string) => string = text => text,
	) {}

	#sync(): void {
		const id = this.manager.getSessionId();
		const leaf = this.manager.getLeafId();
		if (id === this.#sessionId && leaf === this.#leafId) return;
		let entries: SessionEntry[] | undefined;
		if (id === this.#sessionId && this.#leafId !== null) {
			const added: SessionEntry[] = [];
			let cursor = leaf;
			// A normal turn extends the previous leaf by a few entries. Bound the
			// probe so switching branches never decodes the old transcript to find it.
			for (let remaining = 256; cursor !== this.#leafId && cursor !== null && remaining > 0; remaining--) {
				const entry = this.manager.getEntry(cursor);
				if (!entry) break;
				if (entry.type === "custom" && entry.customType === ENTRY_TYPE) added.push(entry);
				cursor = entry.parentId;
			}
			if (cursor === this.#leafId) entries = added.reverse();
		}
		if (!entries) {
			// Selective reads are supplied by the disk-backed session index. The
			// fallback keeps this topic independently usable on the in-memory index.
			const manager = this.manager as SessionManager & {
				getBranchMatching?: (
					predicate: (metadata: { type: string; customType?: string }) => boolean,
				) => SessionEntry[];
			};
			entries = manager.getBranchMatching
				? manager.getBranchMatching(metadata => metadata.type === "custom" && metadata.customType === ENTRY_TYPE)
				: manager.getBranch();
			this.#versions.clear();
		}
		this.#leafId = leaf;
		this.#sessionId = id;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const version = entry.data as InstructionVersion;
			if (typeof version?.path === "string" && typeof version.hash === "string") {
				// A restarted process must stat/hash again, even if timestamps were preserved.
				this.#versions.set(version.path, {
					path: version.path,
					hash: version.hash,
					notices: version.notices,
					mtimeMs: undefined,
				});
			}
		}
	}

	/** Record bytes actually loaded, never skill catalog descriptions. */
	async loaded(filePath: string, body?: string, onlyIfAbsent = false, maxBytes = 16384): Promise<void> {
		this.#sync();
		const absolute = path.resolve(this.manager.getCwd(), filePath);
		if (onlyIfAbsent && this.#versions.has(absolute)) return;
		try {
			const file = Bun.file(absolute);
			const stat = await file.stat();
			if (!stat.isFile()) return;
			const text = body ?? (await file.text());
			const version: InstructionVersion = {
				path: absolute,
				hash: Bun.SHA256.hash(text, "hex"),
				// Provided text may have been read before stat; force the first comparison.
				mtimeMs: body === undefined ? stat.mtimeMs : undefined,
				size: stat.size,
			};
			const previous = this.#versions.get(absolute);
			if (previous?.hash === version.hash) return;
			if (previous) version.notices = [await this.#notice(absolute, text, maxBytes)];
			this.#persist(version);
			this.#versions.set(absolute, version);
		} catch (error) {
			if (!isEnoent(error)) logger.warn("Instruction file tracking failed", { path: absolute, error });
		}
	}

	async loadedInstruction(filePath: string, body?: string, maxBytes = 16384): Promise<void> {
		if (isInstructionFilePath(filePath)) await this.loaded(filePath, body, false, maxBytes);
	}

	/** Commit one notice per content transition. Stat-only when the file has not changed. */
	async refresh(maxBytes: number): Promise<string[]> {
		this.#sync();
		const notices: string[] = [];
		for (const [filePath, previous] of this.#versions) {
			try {
				const file = Bun.file(filePath);
				const stat = await file.stat();
				if (!stat.isFile()) continue;
				if (previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue;
				const body = await file.text();
				const hash = Bun.SHA256.hash(body, "hex");
				if (hash === previous.hash) {
					previous.mtimeMs = stat.mtimeMs;
					previous.size = stat.size;
					continue;
				}
				const notice = await this.#notice(filePath, body, maxBytes);
				const version: InstructionVersion = {
					path: filePath,
					hash,
					mtimeMs: stat.mtimeMs,
					size: stat.size,
					notices: [notice],
				};
				this.#persist(version);
				this.#versions.set(filePath, version);
				notices.push(notice);
			} catch (error) {
				if (!isEnoent(error)) logger.warn("Instruction file refresh failed", { path: filePath, error });
			}
		}
		return notices;
	}

	#persist(version: InstructionVersion): void {
		this.manager.appendCustomEntry(ENTRY_TYPE, {
			...version,
			notices: version.notices?.map(text => this.obfuscate(text)),
		});
		this.#leafId = this.manager.getLeafId();
	}

	async #notice(filePath: string, body: string, maxBytes: number): Promise<string> {
		const loadedFiles = new Map<string, string>();
		const expanded = await expandAtImports(body, filePath, { loadedFiles });
		for (const [importPath, text] of loadedFiles) await this.loaded(importPath, text, true);
		// A diff baseline may have left the request through compaction. Never depend on it.
		return Buffer.byteLength(expanded) <= maxBytes
			? prompt.compile(changedTemplate)({ path: filePath, body: expanded })
			: prompt.compile(rereadTemplate)({ path: filePath });
	}

	/** Latest superseding instructions remain in the system prompt across rebuilds/resume. */
	systemNotices(): string[] {
		this.#sync();
		return [...this.#versions.values()].flatMap(version => version.notices ?? []);
	}
}
