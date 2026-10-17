import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { encodeSixel } from "@oh-my-pi/pi-natives";
import { type HistoryBatch, TUI } from "@oh-my-pi/pi-tui";
import { Box } from "@oh-my-pi/pi-tui/components/box";
import {
	type CellDimensions,
	encodeKonsoleDeleteAtCell,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { bandedSixel, KonsoleSixelTerminal, sixelImageRows } from "./helpers/konsole-sixel-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

withoutTerminalMultiplexer();

const CELL: CellDimensions = { widthPx: 10, heightPx: 12 };
const IMAGE = sixelImageRows(bandedSixel(CELL));
const OTHER_IMAGE = sixelImageRows(bandedSixel(CELL, [4, 5, 6, 7]));

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

describe("Konsole SIXEL scrolling and ownership", () => {
	it("clips the bottom bands of a styled Box-padded image and deletes its real moving column", async () => {
		const term = new KonsoleSixelTerminal(CELL);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const box = new Box(2, 0, text => `\x1b[44m${text}\x1b[0m`);
		box.addChild({ render: () => IMAGE });
		let hidden = 2;
		tui.setFrameProvider({
			renderFrame: size => ({ viewport: [...box.render(size.columns).slice(hidden), "below"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			const clipped = term.placements[0]!;
			expect({ row: clipped.row, col: clipped.col, rows: clipped.rows }).toEqual({ row: 0, col: 2, rows: 2 });
			expect(term.bands(clipped)).toEqual([2, 3]);
			expect(term.getViewportRowBackgroundColumns(0).slice(0, 2)).toEqual([0, 1]);
			hidden = 1;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.placements).toHaveLength(1);
			expect(term.bands(term.placements[0]!)).toEqual([1, 2, 3]);
			expect(term.deletions.map(({ col, removed }) => ({ col, count: removed.length }))).toEqual([
				{ col: 2, count: 1 },
			]);
			expect(term.getViewport()[3]?.trim()).toBe("below");
		} finally {
			tui.stop();
		}
	});

	it("keeps a straddling native raster within its visible 20px text cells", async () => {
		const cell = { widthPx: 10, heightPx: 20 };
		setCellDimensions(cell);
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
			"base64",
		);
		const sixel = encodeSixel(png, 40, 80, 0x000000);
		// Native encoding can round the requested height to complete SIXEL bands.
		const rasterHeight = Number(/"\d+;\d+;\d+;(\d+)/.exec(sixel)?.[1]);
		expect(rasterHeight).toBeGreaterThan(60);
		const image = sixelImageRows(sixel);
		const term = new KonsoleSixelTerminal(cell);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: [...image.slice(2), "below"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			const clipped = term.placements[0]!;
			expect(term.covers(clipped, 2, clipped.col)).toBe(false);
			expect(clipped.pixels).toHaveLength(rasterHeight - 7 * 6);
			expect({ row: clipped.row, rows: clipped.rows }).toEqual({ row: 0, rows: 2 });
			expect(term.getViewport()[2]?.trim()).toBe("below");
			tui.requestRender(true);
			await scheduler.settle(term);
			expect(term.placements).toHaveLength(1);
			expect(term.covers(term.placements[0]!, 2, 0)).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("moving one image after an overflowing history append cannot delete the other image", async () => {
		const term = new KonsoleSixelTerminal(CELL);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let moved = false;
		let pending = true;
		tui.setFrameProvider({
			renderFrame: () => ({
				history: pending ? { id: 1, rows: Array.from({ length: 14 }, (_, i) => `history ${i}`) } : undefined,
				viewport: [
					...(moved ? ["inserted"] : []),
					...IMAGE,
					...(moved ? [""] : ["", ""]),
					...OTHER_IMAGE,
					"tail",
					"editor",
				],
			}),
			acknowledgeHistory() {
				pending = false;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			expect(term.scrolls).toBe(14);
			expect(term.placements.map(p => p.row)).toEqual([0, 6]);
			const other = term.placements[1]!;
			moved = true;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.deletions.flatMap(d => d.removed)).not.toContain(other);
			expect(term.placements).toContain(other);
			expect(term.placements.map(p => p.row).sort((a, b) => a - b)).toEqual([1, 6]);
			expect(term.deletions.every(d => d.removed.length === 1)).toBe(true);
		} finally {
			tui.stop();
		}
	});

	for (const kind of ["append", "replay"] as const) {
		it(`preserves a ${kind} image partly in scrollback through later live repaints and retirement`, async () => {
			const term = new KonsoleSixelTerminal(CELL, 40, 8);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			let pending: HistoryBatch | undefined = { id: 1, kind, rows: IMAGE };
			let visible = true;
			tui.setFrameProvider({
				renderFrame: () => ({
					history: pending,
					viewport: [...(visible ? OTHER_IMAGE : ["replacement", "", "", ""]), "tail", "editor"],
				}),
				acknowledgeHistory() {
					pending = undefined;
				},
			});
			try {
				tui.start();
				await scheduler.settle(term);
				const archived = term.placements.find(p => term.bands(p)[0] === 0)!;
				expect({ row: archived.row, rows: archived.rows }).toEqual({ row: -2, rows: 4 });
				expect(term.bands(archived)).toEqual([0, 1, 2, 3]);
				for (let i = 0; i < 3; i++) {
					tui.requestRender(true);
					await scheduler.settle(term);
				}
				visible = false;
				tui.requestRender();
				await scheduler.settle(term);
				expect(term.placements).toEqual([archived]);
				expect(term.deletions.flatMap(d => d.removed)).not.toContain(archived);
				expect(term.bands(archived).slice(0, -archived.row)).toEqual([0, 1]);
			} finally {
				tui.stop();
			}
		});
	}

	it("clips a live image against its final row before subsequent replay newlines scroll it", async () => {
		const term = new KonsoleSixelTerminal(CELL, 40, 8);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let pending = true;
		tui.setFrameProvider({
			renderFrame: () => ({
				history: pending ? { id: 1, rows: Array.from({ length: 12 }, (_, i) => `history ${i}`) } : undefined,
				viewport: [...IMAGE.slice(2), "below 0", "below 1", "below 2", "below 3", "below 4", "editor"],
			}),
			acknowledgeHistory() {
				pending = false;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			expect(term.placements.map(p => ({ row: p.row, rows: p.rows, bands: term.bands(p) }))).toEqual([
				{ row: 0, rows: 2, bands: [2, 3] },
			]);
			tui.requestRender(true);
			await scheduler.settle(term);
			expect(term.placements).toHaveLength(1);
			expect(term.bands(term.placements[0]!)).toEqual([2, 3]);
		} finally {
			tui.stop();
		}
	});

	it("retains portable SIXEL clipping without sending Konsole's Kitty delete on another terminal", async () => {
		delete Bun.env.KONSOLE_VERSION;
		const term = new KonsoleSixelTerminal(CELL);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: [...IMAGE.slice(2), "below"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			tui.requestRender(true);
			await scheduler.settle(term);
			expect(term.deletions).toEqual([]);
			expect(term.bands(term.paints.at(-1)!)).toEqual([2, 3]);
		} finally {
			tui.stop();
		}
	});

	for (const [key, value] of [
		["TMUX", "/tmp/sixel-test,1,0"],
		["TERM", "screen-256color"],
	] as const) {
		it(`retains portable clipping and erase without positional deletes inside ${key}`, async () => {
			Bun.env[key] = value;
			const term = new KonsoleSixelTerminal(CELL);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			let visible = true;
			tui.setFrameProvider({
				renderFrame: () => ({
					viewport: visible ? [...IMAGE.slice(1), "below"] : ["replacement", "", "", "below"],
				}),
				acknowledgeHistory() {},
			});
			try {
				tui.start();
				await scheduler.settle(term);
				tui.requestRender(true);
				await scheduler.settle(term);
				visible = false;
				tui.requestRender();
				await scheduler.settle(term);
				expect(term.writes.join("")).not.toContain("_Ga=d,d=p,");
				expect(term.bands(term.paints.at(-1)!)).toEqual([1, 2, 3]);
				expect(term.writes.some(write => write.includes("\x1b[2A\x1b[2K\x1b[B"))).toBe(true);
				expect(encodeKonsoleDeleteAtCell(2, 0)).toBe("");
			} finally {
				tui.stop();
			}
		});
	}
});
