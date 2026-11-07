/** Deadline renderers share formatters and bounded rendered values across timer/turn passes. */
const zones = new Map<
	string,
	{
		timestamp: Intl.DateTimeFormat;
		clock: Intl.DateTimeFormat;
		presence: Intl.DateTimeFormat;
		values: Map<number, string>;
		clocks: Map<number, string>;
	}
>();
let localZone: { env: string | undefined; zone: string } | undefined;

function localTimeZone(): string {
	const env = process.env.TZ;
	if (!localZone || localZone.env !== env) {
		localZone = { env, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
	}
	return localZone.zone;
}

export function deadlineFormats(zone: string) {
	let formats = zones.get(zone);
	if (!formats) {
		formats = {
			timestamp: new Intl.DateTimeFormat("en-CA", {
				timeZone: zone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hourCycle: "h23",
			}),
			clock: new Intl.DateTimeFormat("en-GB", {
				timeZone: zone,
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			}),
			presence: new Intl.DateTimeFormat("en-GB", {
				timeZone: zone,
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
				weekday: "short",
			}),
			values: new Map(),
			clocks: new Map(),
		};
		if (zones.size >= 32) zones.delete(zones.keys().next().value!);
		zones.set(zone, formats);
	}
	return formats;
}

export function deadlineTimeZone(timeZone?: string): string {
	const candidate = timeZone || localTimeZone();
	try {
		deadlineFormats(candidate);
		return candidate;
	} catch {
		return localTimeZone();
	}
}

export function deadlineTimestamp(value: number, zone: string): string {
	const { timestamp, values } = deadlineFormats(zone);
	let result = values.get(value);
	if (result === undefined) {
		const parts = timestamp.formatToParts(new Date(value));
		const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
		result = `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second} ${zone}`;
		if (values.size >= 4096) values.delete(values.keys().next().value!);
		values.set(value, result);
	}
	return result;
}

export function deadlineClock(value: number, zone: string): string {
	const { clock, clocks } = deadlineFormats(zone);
	// Cache the exact epoch: historical offsets can cross a minute boundary within a UTC minute.
	let result = clocks.get(value);
	if (result === undefined) {
		result = clock.format(new Date(value));
		if (clocks.size >= 4096) clocks.delete(clocks.keys().next().value!);
		clocks.set(value, result);
	}
	return result;
}
