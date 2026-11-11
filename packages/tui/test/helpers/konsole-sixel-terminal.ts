import type { CellDimensions } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VirtualTerminal } from "../virtual-terminal";

export interface SixelRectangle {
	row: number;
	col: number;
	rows: number;
	cols: number;
	/** Palette index at each pixel of the raster, independent of text erasure. */
	pixels: number[][];
}

/** Four distinguishable cell-high bands, two SIXEL bands per cell. */
export function bandedSixel(cell: CellDimensions, colours = [0, 1, 2, 3]): string {
	const width = cell.widthPx * 4;
	const palette = colours.map(colour => `#${colour};2;${colour % 2 ? 0 : 100};${colour % 3 ? 0 : 100};100`).join("");
	const bands = colours.flatMap(colour => Array.from({ length: cell.heightPx / 6 }, () => `#${colour}!${width}~`));
	return `\x1bP0;1q"1;1;${width};${colours.length * cell.heightPx}${palette}${bands.join("-")}-\x1b\\`;
}

/** The direct-placement rows emitted by Image, before a Box decorates them. */
export function sixelImageRows(sixel: string, rows = 4): string[] {
	return [...Array.from({ length: rows - 1 }, () => "\x1b[0m"), `\x1b7\x1b[${rows - 1}A${sixel}\x1b8`];
}

function decodeSixel(sequence: string): number[][] {
	const raster = /"\d+;\d+;(\d+);(\d+)/.exec(sequence);
	if (!raster) throw new Error("SIXEL fixture lacks raster attributes");
	const pixels = Array.from({ length: Number(raster[2]) }, () => Array<number>(Number(raster[1])).fill(-1));
	let x = 0;
	let y = 0;
	let colour = 0;
	const body = sequence.slice(sequence.indexOf("q") + 1, -2);
	for (const match of body.matchAll(/"\d+;\d+;\d+;\d+|#(\d+)(?:;\d+;\d+;\d+;\d+)?|!(\d+)([?-~])|([?-~])|([-$])/g)) {
		if (match[0].startsWith('"')) continue;
		if (match[1] !== undefined) {
			colour = Number(match[1]);
			continue;
		}
		if (match[5]) {
			x = 0;
			if (match[5] === "-") y += 6;
			continue;
		}
		const bits = (match[3] ?? match[4] ?? "?").charCodeAt(0) - 63;
		const repeat = Number(match[2] ?? 1);
		for (let col = x; col < x + repeat; col++) {
			for (let bit = 0; bit < 6; bit++) {
				if ((bits & (1 << bit)) !== 0 && pixels[y + bit]?.[col] !== undefined) pixels[y + bit]![col] = colour;
			}
		}
		x += repeat;
	}
	return pixels;
}

/**
 * Konsole's graphics lifetime, deliberately separate from the text engine:
 * EL/ED/overwrite cannot erase a raster. Every scrolling LF moves rectangles,
 * including those partly in native history. Cell deletes remove ALL containing
 * rectangles (not just the newest or the live one).
 */
export class KonsoleSixelTerminal extends VirtualTerminal {
	readonly placements: SixelRectangle[] = [];
	readonly paints: SixelRectangle[] = [];
	readonly deletions: { row: number; col: number; removed: SixelRectangle[] }[] = [];
	readonly writes: string[] = [];
	scrolls = 0;

	constructor(
		readonly cell: CellDimensions,
		columns = 40,
		rows = 12,
	) {
		super(columns, rows);
	}

	override write(data: string): void {
		this.writes.push(data);
		// Keep complete escape strings atomic; only real LF bytes can scroll.
		const tokens =
			/\x1bP[0-9;]*q[\s\S]*?\x1b\\|\x1b_G[\s\S]*?\x1b\\|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b.|\n/g;
		let offset = 0;
		for (const match of data.matchAll(tokens)) {
			super.write(data.slice(offset, match.index));
			offset = match.index + match[0].length;
			const token = match[0];
			const deletion = /^\x1b_Ga=d,d=p,x=(\d+),y=(\d+),q=2\x1b\\$/.exec(token);
			if (deletion) {
				const col = Number(deletion[1]);
				const row = Number(deletion[2]);
				const removed = this.placements.filter(p => this.covers(p, row, col));
				this.deletions.push({ row, col, removed });
				for (const placement of removed) this.placements.splice(this.placements.indexOf(placement), 1);
			} else if (/^\x1bP[0-9;]*q/.test(token)) {
				const pixels = decodeSixel(token);
				const cursor = this.getCursor();
				const placement = {
					row: cursor.row,
					col: cursor.col,
					rows: Math.ceil(pixels.length / this.cell.heightPx),
					cols: Math.ceil(pixels[0]!.length / this.cell.widthPx),
					pixels,
				};
				this.placements.push(placement);
				this.paints.push(placement);
				// Konsole's SIXEL addPlacement moves below the raster before ESC 8
				// restores the cursor. At the bottom this scrolls graphics and text.
				const nextRow = cursor.row + placement.rows;
				if (nextRow >= this.rows) {
					const scroll = nextRow - this.rows + 1;
					this.scrolls += scroll;
					for (const physical of this.placements) physical.row -= scroll;
					super.write(`\x1b[${this.rows};1H${"\n".repeat(scroll)}`);
				} else {
					super.write(`\x1b[${nextRow + 1};1H`);
				}
			} else {
				if (token === "\n" && this.getCursor().row === this.rows - 1) {
					this.scrolls++;
					for (const placement of this.placements) placement.row--;
				}
				super.write(token);
			}
		}
		super.write(data.slice(offset));
	}

	covers(placement: SixelRectangle, row: number, col: number): boolean {
		return (
			row >= placement.row &&
			row < placement.row + placement.rows &&
			col >= placement.col &&
			col < placement.col + placement.cols
		);
	}

	/** Pixel colours down the first pixel column, one sample per terminal cell. */
	bands(placement: SixelRectangle): number[] {
		return placement.pixels.filter((_row, index) => index % this.cell.heightPx === 0).map(row => row[0]!);
	}
}
