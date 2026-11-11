import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type HistoryBatch, TUI } from "@oh-my-pi/pi-tui";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	parseSixelDirectPlacements,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { bandedSixel, KonsoleSixelTerminal } from "./helpers/konsole-sixel-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

withoutTerminalMultiplexer();

const CELL: CellDimensions = { widthPx: 10, heightPx: 12 };
const FIRST = bandedSixel(CELL);
const SECOND = bandedSixel(CELL, [4, 5, 6, 7]);

/**
 * The composer attachment band's bottom border row: SIXEL blocks emitted from the interior
 * through `ESC 7 CUU(n) CHA(c) <DCS> ESC 8`, hoisted ahead of the border text. The column is a
 * CHA, so no visible text precedes the block.
 */
function chipRow(blocks: { column: number; sixel: string }[], lift = 4): string {
	const prefix = blocks.map(b => `\x1b[0m\x1b7\x1b[${lift}A\x1b[${b.column + 1}G${b.sixel}\x1b8`).join("");
	return `${prefix}╰── 2x2 ───╯`;
}
const chipBand = (blocks: { column: number; sixel: string }[]): string[] => [
	"╭── #1 ────╮",
	...Array.from({ length: 4 }, () => "│          │"),
	chipRow(blocks),
];

let originalCell: CellDimensions;
let originalProtocol: ImageProtocol | null;
let originalKonsole: string | undefined;
beforeEach(() => {
	originalCell = getCellDimensions();
	originalProtocol = TERMINAL.imageProtocol;
	originalKonsole = Bun.env.KONSOLE_VERSION;
	Bun.env.KONSOLE_VERSION = "260400";
	setCellDimensions(CELL);
	setTerminalImageProtocol(ImageProtocol.Sixel);
});
afterEach(() => {
	setCellDimensions(originalCell);
	setTerminalImageProtocol(originalProtocol);
	if (originalKonsole === undefined) delete Bun.env.KONSOLE_VERSION;
	else Bun.env.KONSOLE_VERSION = originalKonsole;
});

describe("SIXEL placement parsing", () => {
	it("reads the column from CHA and finds every block on a row", () => {
		const parsed = parseSixelDirectPlacements(
			chipRow([
				{ column: 3, sixel: FIRST },
				{ column: 20, sixel: SECOND },
			]),
		);
		expect(parsed.map(p => ({ column: p.column, lift: p.lift, widthPx: p.widthPx, heightPx: p.heightPx }))).toEqual([
			{ column: 3, lift: 4, widthPx: 40, heightPx: 48 },
			{ column: 20, lift: 4, widthPx: 40, heightPx: 48 },
		]);
	});

	it("keeps the visible text width as the column when there is no CHA", () => {
		const parsed = parseSixelDirectPlacements(`  \x1b7\x1b[3A${FIRST}\x1b8`);
		expect(parsed.map(p => ({ column: p.column, lift: p.lift }))).toEqual([{ column: 2, lift: 3 }]);
	});
});

describe("Konsole SIXEL rasters emitted from a CHA-addressed row", () => {
	async function run(
		blocks: () => { column: number; sixel: string }[],
		frames: number,
		after?: (term: KonsoleSixelTerminal) => void,
	): Promise<KonsoleSixelTerminal> {
		const term = new KonsoleSixelTerminal(CELL, 40, 16);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let pending: HistoryBatch | undefined;
		let id = 0;
		tui.setFrameProvider({
			renderFrame: () => ({ history: pending, viewport: ["live", ...chipBand(blocks()), "editor"] }),
			acknowledgeHistory() {
				pending = undefined;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			for (let frame = 0; frame < frames; frame++) {
				pending = { id: ++id, rows: [`history ${id}a`, `history ${id}b`] };
				tui.requestRender();
				await scheduler.settle(term);
			}
			after?.(term);
			return term;
		} finally {
			tui.stop();
		}
	}

	it("leaves one live raster, not a copy per scroll, while history is appended above it", async () => {
		const term = await run(() => [{ column: 1, sixel: FIRST }], 10);
		expect(term.placements).toHaveLength(1);
		const live = term.placements[0]!;
		expect(term.getViewport()[live.row + live.rows - 1]).toContain("│");
		expect({ col: live.col, rows: live.rows }).toEqual({ col: 1, rows: 4 });
		// Every retirement hit the raster it aimed at: nothing was deleted at the left edge.
		expect(term.deletions.every(d => d.col === 1 && d.removed.length === 1)).toBe(true);
	});

	it("tracks both rasters of a two-chip row", async () => {
		const term = await run(
			() => [
				{ column: 1, sixel: FIRST },
				{ column: 17, sixel: SECOND },
			],
			10,
		);
		expect(term.placements.map(p => p.col).sort((a, b) => a - b)).toEqual([1, 17]);
		expect(new Set(term.placements.map(p => p.row)).size).toBe(1);
	});

	it("clips and reanchors every chip during history replay at the viewport top", async () => {
		const term = new KonsoleSixelTerminal(CELL, 40, 8);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let pending = true;
		tui.setFrameProvider({
			renderFrame: () => ({
				history: pending ? { id: 1, rows: Array.from({ length: 12 }, (_, i) => `history ${i}`) } : undefined,
				viewport: [
					...chipBand([
						{ column: 1, sixel: FIRST },
						{ column: 17, sixel: SECOND },
					]).slice(3),
					"below 0",
					"below 1",
					"below 2",
					"below 3",
					"below 4",
				],
			}),
			acknowledgeHistory() {
				pending = false;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			expect(term.placements.map(p => ({ row: p.row, col: p.col, bands: term.bands(p) }))).toEqual([
				{ row: 0, col: 1, bands: [2, 3] },
				{ row: 0, col: 17, bands: [6, 7] },
			]);
			tui.requestRender(true);
			await scheduler.settle(term);
			expect(term.placements).toHaveLength(2);
			expect(term.placements.every(p => p.row === 0)).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("deletes every raster of the row when it disappears", async () => {
		let staged = true;
		const term = new KonsoleSixelTerminal(CELL, 40, 16);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: () => ({
				viewport: [
					"live",
					...(staged
						? chipBand([
								{ column: 1, sixel: FIRST },
								{ column: 17, sixel: SECOND },
							])
						: Array.from({ length: 6 }, () => "")),
					"editor",
				],
			}),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			expect(term.placements).toHaveLength(2);
			staged = false;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.placements).toHaveLength(0);
		} finally {
			tui.stop();
		}
	});
});
