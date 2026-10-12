import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Balance/billing failures are unavailable until a cheap health probe succeeds;
 * without a successful probe the ban lasts at least six hours.
 */
export const PROVIDER_EXHAUSTION_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

const STATE_FILE_NAME = "provider-cooldowns.json";

/** One provider's persisted unavailability record. */
export interface ProviderExhaustionRecord {
	provider: string;
	reason: string;
	recordedAt: number;
	until: number;
}

/** Reason shown in spawn order/fallbacks when an exhausted provider is skipped. */
export interface ProviderExhaustionExclusion {
	provider: string;
	reason: string;
	until: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/**
 * Router state dir shared by every omp process of the user. Overridable so
 * tests can point sessions at isolated fixture dirs.
 */
function stateDir(): string {
	return process.env.OMP_AGENT_ROUTER_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "omp-agent-router");
}

function statePath(): string {
	return path.join(stateDir(), STATE_FILE_NAME);
}

function readPersisted(now: number): Map<string, ProviderExhaustionRecord> {
	const live = new Map<string, ProviderExhaustionRecord>();
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(statePath(), "utf8"));
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (!entry || typeof entry !== "object") continue;
				const record = entry as Partial<ProviderExhaustionRecord>;
				if (typeof record.provider !== "string" || typeof record.until !== "number") continue;
				if (record.until <= now) continue;
				live.set(record.provider.toLowerCase(), {
					provider: record.provider,
					reason: typeof record.reason === "string" ? record.reason : "provider exhausted",
					recordedAt:
						typeof record.recordedAt === "number"
							? record.recordedAt
							: record.until - PROVIDER_EXHAUSTION_COOLDOWN_MS,
					until: record.until,
				});
			}
		}
	} catch {
		// Missing or corrupt state is treated as no recorded bans.
	}
	return live;
}

/** Temp file plus rename so concurrent sessions never observe partial state. */
function writePersisted(records: Iterable<ProviderExhaustionRecord>): void {
	const file = statePath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify([...records], null, "\t"));
	fs.renameSync(tmp, file);
}

function persist(record: ProviderExhaustionRecord): void {
	const merged = readPersisted(Math.min(record.recordedAt, Date.now()));
	const key = record.provider.toLowerCase();
	// Preserve other providers already recorded by earlier sessions.
	const existing = merged.get(key);
	if (!existing || existing.recordedAt <= record.recordedAt) merged.set(key, record);
	writePersisted(merged.values());
}

function clear(provider: string): void {
	const merged = readPersisted(0);
	if (merged.delete(provider.toLowerCase())) writePersisted(merged.values());
}

/** Mark a provider unavailable after a balance/billing/quota failure; shared by all omp processes. */
export function coolDownExhaustedProvider(provider: string, options?: { now?: number; reason?: string }): void {
	const now = options?.now ?? Date.now();
	const detail = options?.reason?.trim() || "provider exhausted";
	const reason = detail.startsWith("billing:") ? detail : `billing: ${detail}`;
	const wasCooling = isProviderExhausted(provider, now);
	persist({ provider, reason, recordedAt: now, until: now + PROVIDER_EXHAUSTION_COOLDOWN_MS });
	if (!wasCooling) {
		logger.warn("Provider exhausted; cooling down fallback routes", {
			provider,
			reason,
			cooldownMs: PROVIDER_EXHAUSTION_COOLDOWN_MS,
			stateFile: statePath(),
		});
	}
}

/** Whether this provider is inside its cross-process exhaustion cooldown. */
export function isProviderExhausted(provider: string, now = Date.now()): boolean {
	return readPersisted(now).has(provider.toLowerCase());
}

/** The live exhaustion record (with the reason surfaced in order/fallbacks), if any. */
export function providerExhaustionRecord(provider: string, now = Date.now()): ProviderExhaustionRecord | undefined {
	return readPersisted(now).get(provider.toLowerCase());
}

/** Explain an exclusion to callers without discarding the original provider error. */
export function providerExhaustionExclusion(provider: string): ProviderExhaustionExclusion | undefined {
	const record = providerExhaustionRecord(provider);
	if (!record) return undefined;
	return { provider, reason: `${record.reason} until ${new Date(record.until).toISOString()}`, until: record.until };
}

/**
 * Cheap balance/health probe: a models-listing GET (no generation, no billing
 * call). A successful response ends the unavailability early; failure keeps the
 * ban until the TTL expires.
 */
export async function probeExhaustedProvider(
	provider: string,
	options: { url: string; headers?: HeadersInit; fetchFn?: FetchLike; timeoutMs?: number },
): Promise<boolean> {
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
	try {
		const response = await fetchFn(options.url, {
			method: "GET",
			headers: options.headers,
			signal: controller.signal,
		});
		if (response.ok) {
			clear(provider);
			logger.warn("Provider health probe succeeded; clearing exhaustion cooldown", { provider });
			return true;
		}
		return false;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Only billing failures ban a provider; rate limits and server errors retain short retries. */
export function isProviderExhaustionError(status: number | undefined, message: string | undefined): boolean {
	const detail = message ?? "";
	if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return false;
	if (status === 402 || /insufficient\s+balance/iu.test(detail)) return true;
	return (
		(status === 403 || (status === undefined && /\b403\b/iu.test(detail))) &&
		/usage[\s_-]+limit|billing[\s_-]+cycle|quota/iu.test(detail)
	);
}
