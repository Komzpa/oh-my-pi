import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { isKittyProtocolActive, setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { FrameTelemetry, frameTelemetry } from "@oh-my-pi/pi-tui/frame-telemetry";
import { VirtualTerminal } from "./virtual-terminal";

class InputProbe implements Component {
	wantsKeyRelease = false;
	text = "ready";

	render(): readonly string[] {
		return [this.text];
	}

	handleInput(data: string): void {
		this.text += data;
	}
}

describe("input-to-paint telemetry", () => {
	let now = 0;
	let telemetry: FrameTelemetry;
	beforeEach(() => {
		now = 0;
		telemetry = new FrameTelemetry({ now: () => now, loggerWarn: () => {} });
		// Exercise real terminal dispatch without retaining fake-clock samples in the shared meter.
		vi.spyOn(frameTelemetry, "beginInput").mockImplementation(label => telemetry.beginInput(label));
		vi.spyOn(frameTelemetry, "recordInput").mockImplementation((label, atMs, wallTimeMs) =>
			telemetry.recordInput(label, atMs, wallTimeMs),
		);
		vi.spyOn(frameTelemetry, "recordRenderRequest").mockImplementation(() => telemetry.recordRenderRequest());
		vi.spyOn(frameTelemetry, "beginRender").mockImplementation(target => telemetry.beginRender(target));
		vi.spyOn(frameTelemetry, "endRender").mockImplementation((target, painted, settled) =>
			telemetry.endRender(target, painted, settled),
		);
	});
	afterEach(() => vi.restoreAllMocks());

	for (const disposition of ["ignored release", "consumed", "transformed release"] as const) {
		it(`does not count idle time after ${disposition}`, () => {
			const wasKittyActive = isKittyProtocolActive();
			const terminal = new VirtualTerminal(40, 8);
			const tui = new TUI(terminal);
			const probe = new InputProbe();
			tui.addChild(probe);
			tui.setFocus(probe);
			try {
				tui.start();
				tui.renderNow();
				setKittyProtocolActive(true);
				const drops = vi.spyOn(telemetry, "logDrop");
				const off = tui.addInputListener(data => {
					if (data !== "ignored") return;
					return disposition === "consumed" ? { consume: true } : { data: "\x1b[97;1:3u" };
				});
				terminal.sendInput(disposition === "ignored release" ? "\x1b[97;1:3u" : "ignored");
				off();
				now += 1_000;
				terminal.sendInput("x");
				now += 5;
				tui.renderNow();
				expect(drops).not.toHaveBeenCalled();
				expect(telemetry.snapshot.lagMs).toBe(5);
			} finally {
				tui.stop();
				setKittyProtocolActive(wasKittyActive);
			}
		});
	}

	it("keeps handler latency when a consuming listener requests a paint", () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const probe = new InputProbe();
		tui.addChild(probe);
		try {
			tui.start();
			tui.renderNow();
			tui.addInputListener(() => {
				now += 100;
				tui.requestRender();
				return { consume: true };
			});
			terminal.sendInput("x");
			now += 5;
			probe.text = "painted";
			tui.renderNow();
			telemetry.refresh();
			expect(telemetry.snapshot.lagMs).toBe(105);
		} finally {
			tui.stop();
		}
	});
});
