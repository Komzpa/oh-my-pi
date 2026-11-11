import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { TUI } from "@oh-my-pi/pi-tui";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { bandedSixel, KonsoleSixelTerminal } from "./helpers/konsole-sixel-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

withoutTerminalMultiplexer();

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const CELL: CellDimensions = { widthPx: 10, heightPx: 12 };

describe("SIXEL straddle", () => {
	let originalCellDims: CellDimensions;
	let originalProtocol: ImageProtocol | null;
	let originalKonsole: string | undefined;

	beforeEach(() => {
		originalCellDims = getCellDimensions();
		originalProtocol = TERMINAL.imageProtocol;
		originalKonsole = Bun.env.KONSOLE_VERSION;
		Bun.env.KONSOLE_VERSION = "260400";
		setCellDimensions(CELL);
		setTerminalImageProtocol(ImageProtocol.Sixel);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setCellDimensions(originalCellDims);
		setTerminalImageProtocol(originalProtocol);
		if (originalKonsole === undefined) delete Bun.env.KONSOLE_VERSION;
		else Bun.env.KONSOLE_VERSION = originalKonsole;
	});

	it("retains the bottom pixels, not repeated top bands, after the image straddles the viewport", async () => {
		const encodeSixel = spyOn(natives, "encodeSixelAsync").mockResolvedValue(bandedSixel(CELL));
		const term = new KonsoleSixelTerminal(CELL);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		for (let i = 0; i < 20; i++) tui.addChild(new Text(`before ${i}`, 0, 0));
		tui.addChild(
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "straddle" },
				{ widthPx: 40, heightPx: 48 },
			),
		);
		try {
			tui.start();
			await scheduler.settle(term);
			await encodeSixel.mock.results[0]?.value;
			await scheduler.settle(term);
			for (let i = 0; i < 10; i++) {
				tui.addChild(new Text(`after ${i}`, 0, 0));
				tui.requestRender();
				await scheduler.settle(term);
			}
			expect(term.placements.map(p => ({ row: p.row, rows: p.rows, bands: term.bands(p) }))).toEqual([
				{ row: 0, rows: 2, bands: [2, 3] },
			]);
			const scrolledBefore = term.scrolls;
			for (let i = 0; i < 3; i++) {
				tui.requestRender(true);
				await scheduler.settle(term);
			}
			expect(term.placements).toHaveLength(1);
			expect(term.bands(term.placements[0]!)).toEqual([2, 3]);
			expect(term.scrolls).toBe(scrolledBefore);
			expect(term.getViewport()[2]?.trimEnd()).toBe("after 0");
		} finally {
			tui.stop();
		}
	});
});
