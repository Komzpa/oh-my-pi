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
import { KonsoleSixelTerminal } from "./helpers/konsole-sixel-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

withoutTerminalMultiplexer();

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const CELL: CellDimensions = { widthPx: 10, heightPx: 20 };

describe("SIXEL block repaint", () => {
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

	it("erases a moved block's previous raster before painting it again", async () => {
		const encodeSixel = spyOn(natives, "encodeSixelAsync");
		const term = new KonsoleSixelTerminal(CELL);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const above = new Text("above", 0, 0);
		tui.addChild(above);
		tui.addChild(
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "moving" },
				{ widthPx: 40, heightPx: 80 },
			),
		);
		tui.addChild(new Text("below", 0, 0));
		try {
			tui.start();
			await scheduler.settle(term);
			await encodeSixel.mock.results[0]?.value;
			await scheduler.settle(term);
			for (const text of ["above\nextra", "above", "above\nextra", "above"]) {
				above.setText(text);
				tui.requestRender();
				await scheduler.settle(term);
				// Placements persist independently of the text engine's EL/overwrite.
				expect(term.placements).toHaveLength(1);
			}
			expect(term.paints).toHaveLength(5);
			expect(term.deletions).toHaveLength(4);
			expect(term.deletions.every(d => d.removed.length === 1)).toBe(true);
			expect(term.placements.map(p => ({ row: p.row, rows: p.rows }))).toEqual([{ row: 1, rows: 4 }]);
			expect(term.getViewport()[5]?.trimEnd()).toBe("below");
		} finally {
			tui.stop();
		}
	});
});
