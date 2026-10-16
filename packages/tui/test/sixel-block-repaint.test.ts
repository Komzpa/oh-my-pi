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
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

import { VirtualTerminal } from "./virtual-terminal";

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const CELL: CellDimensions = { widthPx: 10, heightPx: 20 };
const RASTER = "▓";
const SIXEL = /\x1bP[0-9;]*q[\s\S]*?\x1b\\/g;
/** Kitty delete-by-cell APC: Konsole's surgical SIXEL erase (`a=d,d=p`). */
const KITTY_DELETE_CELL = /\x1b_Ga=d,d=p,x=(\d+),y=(\d+),q=2\x1b\\/g;

/**
 * Model Konsole 26.04 SIXEL placements on the text engine: each DCS adds a
 * placement that paints from the cursor, CSI EL/spaces leave it alone, and
 * only a Kitty `a=d,d=p` whose cell falls inside the rect removes it. `stale`
 * counts paints that land on cells still holding an earlier placement.
 */
function trackKonsoleSixelPlacements(term: VirtualTerminal): { stale: number; paints: number; deletes: number } {
	const state = { stale: 0, paints: 0, deletes: 0 };
	type Placement = { row: number; col: number; rows: number; cols: number };
	const placements: Placement[] = [];
	const realWrite = term.write.bind(term);

	const covers = (placement: Placement, row: number, col: number): boolean =>
		row >= placement.row &&
		row < placement.row + placement.rows &&
		col >= placement.col &&
		col < placement.col + placement.cols;

	vi.spyOn(term, "write").mockImplementation((data: string) => {
		let offset = 0;
		const combined = new RegExp(`${SIXEL.source}|${KITTY_DELETE_CELL.source}`, "g");
		for (const match of data.matchAll(combined)) {
			realWrite(data.slice(offset, match.index));
			offset = match.index + match[0].length;
			if (match[0].startsWith("\x1b_G")) {
				const col = Number(match[1]);
				const row = Number(match[2]);
				const before = placements.length;
				for (let i = placements.length - 1; i >= 0; i--) {
					if (covers(placements[i]!, row, col)) placements.splice(i, 1);
				}
				if (placements.length < before) state.deletes++;
				continue;
			}
			const raster = /"\d+;\d+;(\d+);(\d+)/.exec(match[0]);
			if (!raster) continue;
			const columns = Math.ceil(Number(raster[1]) / CELL.widthPx);
			const rows = Math.ceil(Number(raster[2]) / CELL.heightPx);
			const cursor = term.getCursor();
			for (const placement of placements) {
				for (let row = cursor.row; row < cursor.row + rows; row++) {
					for (let col = cursor.col; col < cursor.col + columns; col++) {
						if (covers(placement, row, col)) {
							state.stale++;
							break;
						}
					}
				}
			}
			placements.push({ row: cursor.row, col: cursor.col, rows, cols: columns });
			state.paints++;
			let paint = "\x1b7";
			for (let row = 0; row < rows; row++) paint += `${RASTER.repeat(columns)}\x1b[${columns}D\x1b[B`;
			realWrite(`${paint}\x1b8`);
		}
		realWrite(data.slice(offset));
	});
	return state;
}

describe("SIXEL block repaint", () => {
	let originalCellDims: CellDimensions;
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions(CELL);
		setTerminalImageProtocol(ImageProtocol.Sixel);
		vi.useFakeTimers();
		// One full 30fps frame per read: the render throttle never defers a frame.
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (now += 40));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setCellDimensions(originalCellDims);
		setTerminalImageProtocol(originalProtocol);
	});

	/** Run the `setImmediate` render hop and any throttled frame timer it arms. */
	async function settle(term: VirtualTerminal): Promise<void> {
		for (let i = 0; i < 2; i++) {
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			vi.advanceTimersByTime(40);
			await term.flush();
		}
	}

	it("erases a moved block's previous raster before painting it again", async () => {
		const encodeSixel = spyOn(natives, "encodeSixelAsync");
		const term = new VirtualTerminal(40, 12);
		const raster = trackKonsoleSixelPlacements(term);
		const tui = new TUI(term);
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
			await settle(term);
			await encodeSixel.mock.results[0]?.value;
			await settle(term);
			// Each frame moves the block one row inside the viewport: a diffable
			// frame in which its reserved rows are byte-identical and skipped.
			// Konsole keeps the previous placement until a Kitty cell-delete
			// covers its origin; without that delete every move leaves a ghost.
			for (const text of ["above\nextra", "above", "above\nextra", "above"]) {
				above.setText(text);
				tui.requestRender();
				await settle(term);
			}
			expect(raster.paints).toBe(5);
			expect(raster.deletes).toBeGreaterThan(0);
			expect(raster.stale).toBe(0);
			// Back on rows 1..4: exactly one raster, nothing left behind.
			const rasterRows = term.getViewport().flatMap((line, row) => (line.includes(RASTER) ? [row] : []));
			expect(rasterRows).toEqual([1, 2, 3, 4]);
		} finally {
			tui.stop();
		}
	});
});
