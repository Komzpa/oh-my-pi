import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

import { VirtualTerminal } from "./virtual-terminal";

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const CELL: CellDimensions = { widthPx: 10, heightPx: 20 };
const RASTER = "▓";
const SIXEL = /\x1bP[0-9;]*q[\s\S]*?\x1b\\/g;

/**
 * Model a SIXEL raster on the text engine (see sixel-block-repaint.test.ts):
 * each DCS paints cells from the cursor down its pixel height, and the
 * recorded paints expose the cursor row each one landed on.
 */
function trackSixelPaints(term: VirtualTerminal): { row: number; rows: number }[] {
	const paints: { row: number; rows: number }[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		let offset = 0;
		for (const match of data.matchAll(SIXEL)) {
			realWrite(data.slice(offset, match.index));
			offset = match.index + match[0].length;
			const raster = /"\d+;\d+;(\d+);(\d+)/.exec(match[0]);
			if (!raster) continue;
			const columns = Math.ceil(Number(raster[1]) / CELL.widthPx);
			const rows = Math.ceil(Number(raster[2]) / CELL.heightPx);
			const cursor = term.getCursor();
			paints.push({ row: cursor.row, rows });
			let paint = "";
			for (let row = 0; row < rows; row++) paint += `${RASTER.repeat(columns)}\x1b[${columns}D\x1b[B`;
			realWrite(`${paint}\x1b[${rows}A`);
		}
		realWrite(data.slice(offset));
	});
	return paints;
}

describe("SIXEL straddle", () => {
	let originalCellDims: CellDimensions;
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions(CELL);
		setTerminalImageProtocol(ImageProtocol.Sixel);
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (now += 40));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setCellDimensions(originalCellDims);
		setTerminalImageProtocol(originalProtocol);
	});

	async function settle(term: VirtualTerminal): Promise<void> {
		for (let i = 0; i < 2; i++) {
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			vi.advanceTimersByTime(40);
			await term.flush();
		}
	}

	it("paints only the visible bottom slice when the block's top scrolls past the viewport", async () => {
		const term = new VirtualTerminal(40, 12);
		const paints = trackSixelPaints(term);
		const tui = new TUI(term);
		// 4-row image block (80px tall at 20px cells) after 20 prose rows.
		for (let i = 0; i < 20; i++) tui.addChild(new Text(`before ${i}`, 0, 0));
		tui.addChild(
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: 4, imageKey: "straddle" },
				{ widthPx: 40, heightPx: 80 },
			),
		);
		try {
			tui.start();
			await settle(term);
			// Grow the transcript below the block until its first two rows
			// scroll past the top of the 12-row viewport.
			for (let i = 0; i < 10; i++) {
				tui.addChild(new Text(`after ${i}`, 0, 0));
				tui.requestRender();
				await settle(term);
			}
			// Two of the four image rows are visible: the paint must cover
			// exactly those two rows at the viewport top, not the full block
			// anchored at a clamped row 0.
			const straddlePaints = paints.filter(paint => paint.rows === 4 || paint.rows === 2);
			const last = straddlePaints.at(-1);
			expect(last).toBeDefined();
			expect(last?.rows).toBe(2);
			expect(last?.row).toBe(0);
			const rasterRows = term.getViewport().flatMap((line, row) => (line.includes(RASTER) ? [row] : []));
			expect(rasterRows).toEqual([0, 1]);
			// Forced repaints while the block still straddles must not stack
			// copies of its top into native scrollback.
			const scrolledBefore = term.getScrollBuffer().filter(line => line.includes(RASTER)).length;
			for (let i = 0; i < 3; i++) {
				tui.requestRender(true);
				await settle(term);
			}
			expect(term.getViewport().flatMap((line, row) => (line.includes(RASTER) ? [row] : []))).toEqual([0, 1]);
			expect(term.getScrollBuffer().filter(line => line.includes(RASTER)).length).toBe(scrolledBefore);
		} finally {
			tui.stop();
		}
	});
});
