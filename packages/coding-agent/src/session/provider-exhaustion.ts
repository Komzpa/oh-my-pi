import { logger } from "@oh-my-pi/pi-utils";

/** Balance and monthly quota failures are unlikely to clear during short retries. */
export const PROVIDER_EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1_000;

const exhaustedUntil = new Map<string, number>();

/** Mark a provider temporarily unavailable after a balance/quota failure. */
export function coolDownExhaustedProvider(provider: string, now = Date.now()): void {
	const key = provider.toLowerCase();
	const wasCooling = isProviderExhausted(key, now);
	exhaustedUntil.set(key, now + PROVIDER_EXHAUSTION_COOLDOWN_MS);
	if (!wasCooling) {
		logger.warn("Provider exhausted; cooling down fallback routes", {
			provider,
			cooldownMs: PROVIDER_EXHAUSTION_COOLDOWN_MS,
		});
	}
}

/** Whether this provider is still inside its process-wide exhaustion cooldown. */
export function isProviderExhausted(provider: string, now = Date.now()): boolean {
	const key = provider.toLowerCase();
	const until = exhaustedUntil.get(key);
	if (until === undefined) return false;
	if (until <= now) {
		exhaustedUntil.delete(key);
		return false;
	}
	return true;
}

/** Only permanent balance or quota/usage failures cool a provider process-wide. */
export function isProviderExhaustionError(status: number | undefined, message: string | undefined): boolean {
	const detail = message ?? "";
	if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return false;
	if (status === 402) return true;
	if (status === 403 || /\b403\b/iu.test(detail)) return /quota|usage limit|monthly usage/iu.test(detail);
	if (status !== undefined) return false;
	return /balance|credit|insufficient|quota|usage limit|monthly usage/iu.test(detail);
}
