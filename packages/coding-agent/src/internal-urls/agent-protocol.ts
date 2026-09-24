/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs against the artifacts directories of every active
 * session. Parents and subagents share outputs via this registry: a subagent
 * can read its parent's output IDs because both sessions are registered in
 * the shared context.
 *
 * URL forms:
 * - agent://<id> - Full output content. Nested subagent outputs are
 *   dot-qualified ids (`agent://Parent.Child` resolves `Parent.Child.md`).
 * - agent://<id>/<path> - JSON extraction: each segment is an object key, or
 *   an array index when the current value is an array
 *   (`agent://Parent.Child/reports/0/data`)
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { executeSend, isIrcEnabled } from "../irc/messaging";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import agentPromptDoc from "../prompts/internal-urls/agent.md" with { type: "text" };
import { HistoryProtocolHandler } from "./history-protocol";
import { parseInternalUrl } from "./parse";
import { artifactsDirsFromRegistry, sessionFilesFromDisk } from "./registry-helpers";
import type {
	InternalResource,
	InternalWriteResult,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
	WriteContext,
} from "./types";

/** Result of scanning the caller's artifact dirs for `<id>.md`. */
interface OutputScan {
	foundPath?: string;
	jsonPath?: string;
	anyDirExists: boolean;
	availableIds: Set<string>;
}

interface OutputLookupContext {
	dirs: string[];
	preferredDir?: string;
}

/** True when the URL extracts a `/<json-path>` value instead of naming the whole output. */
function hasPathExtraction(url: InternalUrl): boolean {
	return url.pathname !== "" && url.pathname !== "/";
}

function isPathInsideDir(file: string, dir: string): boolean {
	const relative = path.relative(dir, file);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sessionFileBelongsToDir(file: string, dir: string): boolean {
	return path.resolve(file) === path.resolve(`${dir}.jsonl`) || isPathInsideDir(file, dir);
}

function isUnknownAgentError(error: unknown, id: string): boolean {
	return error instanceof Error && error.message.startsWith(`Unknown agent: ${id}\n`);
}

/**
 * Walk `segments` into a JSON value: object segments index by key, array
 * segments by numeric index. Returns `undefined` once a segment misses.
 */
function extractJsonPath(data: unknown, segments: string[]): unknown {
	let current: unknown = data;
	for (const segment of segments) {
		if (current === null || typeof current !== "object") return undefined;
		if (Array.isArray(current)) {
			current = /^\d+$/.test(segment) ? current[Number(segment)] : undefined;
			continue;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly spec: SchemeSpec = {
		backing: "file",
		selectors: "lines",
		immutable: true,
		linkable: true,
		write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "read" },
	};

	promptDoc(): string {
		return agentPromptDoc.trim();
	}

	/**
	 * The `<id>.md` output file. JSON-path URLs (`/<json-path>`) render a value
	 * rather than the file, so they locate to null, as do missing ids.
	 */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) throw new Error("agent:// URL requires an output ID: agent://<id>");
		if (outputId === "all" || hasPathExtraction(url)) return null;
		const { dirs, preferredDir } = await this.#outputLookupContext(context);
		const scan = dirs.length > 0 ? await this.#findOutput(dirs, outputId) : this.#emptyScan();
		return scan.foundPath ?? (await this.#findRegisteredOutput(outputId, preferredDir))?.foundPath ?? null;
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const session = context?.session;
		if (!session) throw new Error("agent:// messaging requires a tool session");
		const registry = session.agentRegistry;
		const senderId = session.getAgentId?.();
		if (
			!registry ||
			!senderId ||
			session.enableIrc === false ||
			!isIrcEnabled(session.settings, session.taskDepth ?? 0)
		) {
			throw new Error("Peer messaging is unavailable in this session.");
		}
		const to = url.rawHost || url.hostname;
		if (!to) throw new Error("agent:// URL requires a recipient: agent://<id>");
		if (hasPathExtraction(url)) {
			throw new Error("agent:// message target cannot have a JSON-path suffix.");
		}
		if (!content.trim()) throw new Error("agent:// messages require non-empty content.");
		const result = await executeSend(
			{ registry, senderId, sessionFileHint: session.getSessionFile?.() },
			{ to, message: content },
		);
		return {
			content: [
				{
					type: "text",
					text: result.content.find(item => item.type === "text")?.text ?? "Message delivery failed.",
				},
			],
			details: { message: result.details },
			isError: result.isError,
		};
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (outputId === "all") throw new Error("agent://all is write-only; use it to broadcast a message.");
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		const extraction = hasPathExtraction(url);

		const { dirs, preferredDir } = await this.#outputLookupContext(context);

		const pathSegments = extraction ? url.pathname.split("/").filter(Boolean) : [];
		const decodedSegments = pathSegments.map(segment => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});

		let scan = dirs.length > 0 ? await this.#findOutput(dirs, outputId) : this.#emptyScan();
		if (!scan.foundPath) {
			const registered = await this.#findRegisteredOutput(outputId, preferredDir);
			if (registered) {
				scan = {
					foundPath: registered.foundPath,
					jsonPath: registered.jsonPath,
					anyDirExists: true,
					availableIds: new Set([...scan.availableIds, outputId]),
				};
			}
		}
		if (!scan.anyDirExists) {
			if (!extraction) {
				const transcript = await this.#resolveTranscriptFallback(url, outputId, context, preferredDir);
				if (transcript) return transcript;
			}
			throw new Error("No artifacts directory found");
		}
		if (!scan.foundPath) {
			if (!extraction) {
				const transcript = await this.#resolveTranscriptFallback(url, outputId, context, preferredDir);
				if (transcript) return transcript;
			}
			const availableStr = scan.availableIds.size > 0 ? [...scan.availableIds].join(", ") : "none";
			throw new Error(`Not found: ${outputId}\nAvailable: ${availableStr}`);
		}

		const rawContent = await Bun.file(scan.foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";

		let extractedFrom = scan.foundPath;
		if (extraction) {
			let jsonValue: unknown;
			let parsed = false;
			if (scan.jsonPath) {
				try {
					jsonValue = JSON.parse(await Bun.file(scan.jsonPath).text());
					extractedFrom = scan.jsonPath;
					parsed = true;
				} catch {
					// Corrupt or partially written sidecar: fall back to <id>.md.
				}
			}
			if (!parsed) {
				try {
					jsonValue = JSON.parse(rawContent);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Output ${outputId} is not valid JSON: ${message}`);
				}
			}

			const extracted = extractJsonPath(jsonValue, decodedSegments);
			if (typeof extracted === "string") {
				// A string field (e.g. a scout's markdown `report`) reads as prose,
				// not as a JSON-escaped single line.
				content = extracted;
			} else {
				try {
					content = JSON.stringify(extracted, null, 2) ?? "null";
				} catch {
					content = String(extracted);
				}
				contentType = "application/json";
			}
			notes.push(`Extracted: /${decodedSegments.join("/")}`);
			if (parsed) notes.push(`Source: ${path.basename(extractedFrom!)}`);
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: extractedFrom,
			notes,
			shape: extraction ? "value" : "document",
		};
	}

	/**
	 * Artifact dirs to scan for the caller's outputs, in priority order.
	 *
	 * The caller root's canonical artifact directory (its session file minus
	 * the `.jsonl` suffix) is scanned FIRST, ahead of every process-global
	 * registry dir. The roster ref the refresh installs for the caller's
	 * parked id contributes only its nested child dir, not the root dir that
	 * actually holds `<id>.md` — and with two coexisting roots the global
	 * `Main` ref can belong to the other root, whose dir would otherwise win
	 * the first-hit id map for a shared id. No caller session file: keep the
	 * pre-existing global scan untouched.
	 */
	async #outputLookupContext(context: ResolveContext | undefined): Promise<OutputLookupContext> {
		const rootSessionFile = context?.sessionFile
			? await ensurePersistedRoster(AgentRegistry.global(), context.sessionFile)
			: undefined;
		const preferredDir = rootSessionFile ? rootSessionFile.slice(0, -6) : undefined;
		return {
			dirs: artifactsDirsFromRegistry(preferredDir ? { preferredDir } : undefined),
			preferredDir,
		};
	}

	/**
	 * Scan every registered artifacts dir (in priority order) for `<id>.md`.
	 * Returns the resolved path and its same-dir `.json` sidecar, plus the set
	 * of available ids gathered from the scanned dirs for the not-found message.
	 */
	async #findOutput(dirs: string[], id: string): Promise<OutputScan> {
		const byId = new Map<string, string>();
		const jsonById = new Map<string, string>();
		let anyDirExists = false;
		for (const dir of dirs) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			anyDirExists = true;
			for (const f of files) {
				if (f.endsWith(".json")) {
					const jsonId = f.slice(0, -5);
					if (!jsonById.has(jsonId)) jsonById.set(jsonId, path.join(dir, f));
					continue;
				}
				if (!f.endsWith(".md")) continue;
				const id = f.slice(0, -3);
				if (!byId.has(id)) byId.set(id, path.join(dir, f));
			}
		}
		const availableIds = new Set(byId.keys());
		const foundPath = byId.get(id);
		if (!foundPath) return { anyDirExists, availableIds };
		// Pair the sidecar with the SAME dir as the matched `<id>.md`: two
		// coexisting roots can both hold `Worker`, and a first-hit sidecar
		// from the other root would answer with a foreign agent's payload
		// (see the `preferredDir` comment above and caller-root-ab.test.ts).
		const sidecar = jsonById.get(id);
		const jsonPath = sidecar && path.dirname(sidecar) === path.dirname(foundPath) ? sidecar : undefined;
		return { foundPath, jsonPath, anyDirExists, availableIds };
	}

	#emptyScan(): OutputScan {
		return { anyDirExists: false, availableIds: new Set() };
	}

	async #findRegisteredOutput(
		id: string,
		preferredDir: string | undefined,
	): Promise<{ foundPath: string; jsonPath?: string } | undefined> {
		const ref = this.#findRegisteredRef(id);
		const outputPath = ref?.history?.outputPath;
		if (!outputPath) return undefined;
		if (preferredDir && !isPathInsideDir(outputPath, preferredDir)) return undefined;
		try {
			const stat = await fs.stat(outputPath);
			if (!stat.isFile()) return undefined;
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw err;
		}
		const jsonPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, ".md")}.json`);
		try {
			const stat = await fs.stat(jsonPath);
			return { foundPath: outputPath, jsonPath: stat.isFile() ? jsonPath : undefined };
		} catch (err) {
			if (isEnoent(err)) return { foundPath: outputPath };
			throw err;
		}
	}

	#findRegisteredRef(id: string): AgentRef | undefined {
		const registry = AgentRegistry.global();
		const lower = id.toLowerCase();
		return (
			registry.get(id) ??
			registry.list().find(candidate => candidate.kind !== "advisor" && candidate.id.toLowerCase() === lower)
		);
	}

	async #resolveTranscriptFallback(
		url: InternalUrl,
		outputId: string,
		context: ResolveContext | undefined,
		preferredDir: string | undefined,
	): Promise<InternalResource | undefined> {
		if (preferredDir) {
			const ref = this.#findRegisteredRef(outputId);
			const refBelongs = ref?.sessionFile ? sessionFileBelongsToDir(ref.sessionFile, preferredDir) : false;
			if (ref?.session && refBelongs) {
				return await this.#resolveTranscriptFromHistory(url, outputId, context);
			}
			const disk = await this.#resolveTranscriptFromDisk(url, outputId, preferredDir);
			if (disk) return disk;
			if (!ref || !refBelongs) return undefined;
		}
		return await this.#resolveTranscriptFromHistory(url, outputId, context);
	}

	async #resolveTranscriptFromHistory(
		url: InternalUrl,
		outputId: string,
		context: ResolveContext | undefined,
	): Promise<InternalResource | undefined> {
		try {
			const transcript = await new HistoryProtocolHandler().resolve(
				parseInternalUrl(`history://${encodeURIComponent(outputId)}`),
				context,
			);
			return {
				...transcript,
				url: url.href,
				notes: [
					...(transcript.notes ?? []),
					"Fallback: no agent output artifact found; serving worker transcript.",
				],
				shape: "document",
			};
		} catch (error) {
			if (!isUnknownAgentError(error, outputId)) throw error;
			return undefined;
		}
	}

	async #resolveTranscriptFromDisk(
		url: InternalUrl,
		outputId: string,
		preferredDir: string,
	): Promise<InternalResource | undefined> {
		const files = await sessionFilesFromDisk(preferredDir);
		const lower = outputId.toLowerCase();
		let match: { id: string; file: string } | undefined;
		for (const [id, file] of files) {
			if (!sessionFileBelongsToDir(file, preferredDir)) continue;
			if (id === outputId || id.toLowerCase() === lower) {
				match = { id, file };
				if (id === outputId) break;
			}
		}
		if (!match) return undefined;
		const messages = await loadSessionMessagesReadOnly(match.file);
		const content = formatSessionHistoryMarkdown(messages, { title: `${match.id} (on disk)` });
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: match.file,
			notes: [
				"Source: session file (read-only, unregistered)",
				"Fallback: no agent output artifact found; serving worker transcript.",
			],
			shape: "document",
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		for (const dir of artifactsDirsFromRegistry()) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				if (f.endsWith(".md")) ids.add(f.slice(0, -3));
			}
		}
		return [...ids].sort().map(value => ({ value }));
	}
}
