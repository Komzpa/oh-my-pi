import { beforeAll, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class Rows implements Component {
	reads = 0;
	constructor(
		readonly label: string,
		public count: number,
	) {}
	render(): readonly string[] {
		this.reads++;
		return Array.from({ length: this.count }, (_, index) => `${this.label} ${index}`);
	}
}

beforeAll(initTheme);

it("reuses versioned worker roots across paints and refreshes mutations and resize", () => {
	const composer = new Composer({ terminal: new VirtualTerminal(80, 24), preferences: { quiet: true } });
	const transcript = new TranscriptContainer();
	const workers = new Rows("WORKER", 2);
	const input = new Rows("INPUT", 1);
	let version = 0;
	composer.setRuntimeChildren([transcript, workers, input], {
		renderVersion: root => (root === workers ? version : undefined),
		allocation: {
			hud: workers,
			input,
			apply: (_viewport, _chrome, renderInput) => {
				renderInput();
			},
		},
	});
	composer.start({ playWelcomeIntro: false });
	try {
		composer.renderFrame({ columns: 80, rows: 24 });
		composer.renderFrame({ columns: 80, rows: 24 });
		expect(workers.reads).toBe(1);
		expect(input.reads).toBe(2);
		workers.count = 3;
		version++;
		const changed = composer.renderFrame({ columns: 80, rows: 24 });
		expect(changed.viewport.filter(line => line.includes("WORKER"))).toHaveLength(3);
		expect(workers.reads).toBe(2);
		composer.renderFrame({ columns: 60, rows: 24 });
		expect(workers.reads).toBe(3);
	} finally {
		composer.stop();
	}
});
