import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileEntry } from "./session-entries";

/** Read-only append observer. Keeps incomplete UTF-8 records for the next poll by their byte offset. */
export class JournalCursor {
	#offset = 0;
	#identity: string | undefined;
	#mtime = 0;
	#size = 0;
	/** First bytes seen at offset 0; an in-place rewrite that grows past the old size changes them. */
	#prefix: Buffer | undefined;

	#tail: Promise<void> = Promise.resolve();
	read(
		file: string,
		visit: (entry: FileEntry) => void,
		reset: () => void,
		shouldContinue: () => boolean = () => true,
	): Promise<void> {
		const read = this.#tail.then(() => this.#read(file, visit, reset, shouldContinue));
		this.#tail = read.catch(() => {});
		return read;
	}
	async #read(
		file: string,
		visit: (entry: FileEntry) => void,
		reset: () => void,
		shouldContinue: () => boolean,
	): Promise<void> {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(file, "r");
		} catch (error) {
			if (!isEnoent(error)) throw error;
			this.#identity = undefined;
			this.#offset = 0;
			this.#prefix = undefined;
			reset();
			return;
		}
		try {
			const stat = await handle.stat();
			const identity = `${file}:${stat.dev}:${stat.ino}`;
			let rewritten = false;
			if (this.#prefix && identity === this.#identity && stat.size >= this.#prefix.length) {
				const probe = Buffer.allocUnsafe(this.#prefix.length);
				const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
				rewritten = bytesRead !== probe.length || !probe.equals(this.#prefix);
			}
			if (
				rewritten ||
				identity !== this.#identity ||
				stat.size < this.#size ||
				(stat.size === this.#size && stat.mtimeMs !== this.#mtime)
			) {
				this.#offset = 0;
				this.#prefix = undefined;
				reset();
			}
			if (!this.#prefix && stat.size > 0) {
				const head = Buffer.allocUnsafe(Math.min(4096, stat.size));
				const { bytesRead } = await handle.read(head, 0, head.length, 0);
				this.#prefix = Buffer.from(head.subarray(0, bytesRead));
			}
			this.#identity = identity;
			this.#size = stat.size;
			this.#mtime = stat.mtimeMs;
			let position = this.#offset;
			let pending: Buffer[] = [];
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let sinceYield = 0;
			while (position < stat.size && shouldContinue()) {
				const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
				if (!bytesRead) break;
				let start = 0;
				for (;;) {
					const newline = buffer.indexOf(10, start);
					if (newline < 0 || newline >= bytesRead) break;
					const fragment = buffer.subarray(start, newline);
					const line = pending.length
						? Buffer.concat([...pending, fragment]).toString("utf8")
						: fragment.toString("utf8");
					pending = [];
					let entry: FileEntry | undefined;
					try {
						entry = JSON.parse(line) as FileEntry;
					} catch {
						/* Title slot or malformed record. */
					}
					if (entry && typeof entry === "object") visit(entry);
					this.#offset = position + newline + 1;
					start = newline + 1;
				}
				if (start < bytesRead) pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
				position += bytesRead;
				sinceYield += bytesRead;
				if (sinceYield >= 1024 * 1024) {
					sinceYield = 0;
					await Bun.sleep(0);
				}
			}
			// Imported journals may end in a complete JSON object without a newline.
			// Consume valid EOF records once; retain syntactically incomplete bytes.
			if (position === stat.size && pending.length && shouldContinue()) {
				let entry: FileEntry | undefined;
				try {
					entry = JSON.parse(Buffer.concat(pending).toString("utf8")) as FileEntry;
				} catch {}
				if (entry && typeof entry === "object") {
					visit(entry);
					this.#offset = position;
				}
			}
		} catch (error) {
			this.#identity = undefined;
			this.#offset = 0;
			this.#prefix = undefined;
			reset();
			throw error;
		} finally {
			await handle.close();
		}
	}
}
