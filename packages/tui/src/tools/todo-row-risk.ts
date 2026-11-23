/** Empirical attempt chains. Quantiles clamp at the supplied tail observations. */
export interface RowRiskQuantiles {
	q: number[];
	v: number[];
}
export interface RowRiskComponent {
	n: number;
	n_eff: number;
	p_redo: number[];
	attempt_ratio: RowRiskQuantiles;
	gap_ratio: RowRiskQuantiles;
}
export interface RowRiskFile {
	version: 1;
	generatedAt: string;
	window: { start: string; end: string };
	source: { runs: string; labels: string };
	unit: string;
	components: Record<string, Record<string, RowRiskComponent>>;
}
export interface RowRiskOptions {
	components: RowRiskFile;
	pools: Record<string, readonly { model: string; weight: number }[]>;
	defaultWorkerType?: string;
	seed?: number;
	samples?: number;
}
export interface RowRiskForecast {
	onTimeProbability?: number;
	p50Finish: number;
	p80Finish: number;
	p90Finish: number;
	samples: number;
	criticalRows: { content: string; workerType: string; redoRisk: number; lastFinishProbability: number }[];
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validQuantiles(value: unknown): boolean {
	if (!record(value) || !Array.isArray(value.q) || !Array.isArray(value.v)) return false;
	return (
		value.q.length === 7 &&
		value.v.length === 7 &&
		value.q.every((q, i) => q === [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95][i]) &&
		value.v.every((v, i, a) => typeof v === "number" && Number.isFinite(v) && v >= 0 && (i === 0 || v >= a[i - 1]))
	);
}
export function parseRowRiskFile(value: unknown, now: number): RowRiskFile | undefined {
	if (!record(value) || value.version !== 1 || typeof value.generatedAt !== "string") return;
	const generated = Date.parse(value.generatedAt);
	if (!Number.isFinite(generated) || generated > now || now - generated > 14 * 86400_000) return;
	if (
		!record(value.window) ||
		![value.window.start, value.window.end].every(v => typeof v === "string" && Number.isFinite(Date.parse(v)))
	)
		return;
	if (
		!record(value.source) ||
		typeof value.source.runs !== "string" ||
		typeof value.source.labels !== "string" ||
		typeof value.unit !== "string" ||
		!record(value.components)
	)
		return;
	for (const cells of Object.values(value.components)) {
		if (!record(cells)) return;
		for (const cell of Object.values(cells)) {
			if (
				!record(cell) ||
				!Number.isInteger(cell.n) ||
				(cell.n as number) < 0 ||
				typeof cell.n_eff !== "number" ||
				!Number.isFinite(cell.n_eff) ||
				cell.n_eff < 0 ||
				!Array.isArray(cell.p_redo) ||
				cell.p_redo.length !== 3 ||
				!cell.p_redo.every(p => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) ||
				!validQuantiles(cell.attempt_ratio) ||
				!validQuantiles(cell.gap_ratio)
			)
				return;
		}
	}
	if (!record(value.components["*"]) || !value.components["*"]["*"]) return;
	return value as unknown as RowRiskFile;
}
export function riskRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function quantile(table: RowRiskQuantiles, p: number): number {
	if (p <= table.q[0]) return table.v[0];
	for (let i = 1; i < table.q.length; i++) {
		if (p <= table.q[i])
			return table.v[i - 1] + ((table.v[i] - table.v[i - 1]) * (p - table.q[i - 1])) / (table.q[i] - table.q[i - 1]);
	}
	return table.v.at(-1)!;
}
function conditionalRatio(table: RowRiskQuantiles, elapsed: number, random: () => number): number {
	if (elapsed <= 0) return quantile(table, random());
	if (elapsed >= table.v.at(-1)!) return elapsed;
	let low = 0;
	let high = 1;
	for (let i = 0; i < 32; i++) {
		const mid = (low + high) / 2;
		if (quantile(table, mid) <= elapsed) low = mid;
		else high = mid;
	}
	return quantile(table, low + random() * (1 - low));
}
export function riskCells(
	options: RowRiskOptions,
	workerType: string,
): { component: RowRiskComponent; weight: number }[] {
	const type = options.components.components[workerType];
	const fallback = type?.["*"] ?? options.components.components["*"]["*"];
	const cells = (options.pools[workerType] ?? [])
		.filter(entry => Number.isFinite(entry.weight) && entry.weight > 0)
		.map(entry => ({ component: type?.[entry.model] ?? fallback, weight: entry.weight }));
	return cells.length ? cells : [{ component: fallback, weight: 1 }];
}
export function drawAttemptChain(
	options: RowRiskOptions,
	workerType: string,
	mean: number,
	attempt: number,
	elapsed: number,
	random: () => number,
): number {
	const cells = riskCells(options, workerType);
	const total = cells.reduce((sum, cell) => sum + cell.weight, 0);
	let duration = 0;
	for (let count = 0; count < 128; count++, attempt++) {
		let target = random() * total;
		const component = (cells.find(cell => (target -= cell.weight) < 0) ?? cells.at(-1)!).component;
		duration += Math.max(
			0,
			conditionalRatio(component.attempt_ratio, count === 0 ? elapsed / mean : 0, random) * mean -
				(count === 0 ? elapsed : 0),
		);
		if (random() >= component.p_redo[Math.min(attempt - 1, 2)]) return duration;
		duration += quantile(component.gap_ratio, random()) * mean;
	}
	// A non-terminating fitted chain cannot yield a falsely optimistic deadline.
	return Number.POSITIVE_INFINITY;
}
