import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("FileSessionStorage streamed rewrite durability", () => {
	it("preserves the saved transcript when a pending write later fails with ENOSPC", async () => {
		using tempDir = TempDir.createSync("@omp-streamed-rewrite-");
		const sessionPath = path.join(tempDir.path(), "session.jsonl");
		const storage = new FileSessionStorage();
		const saved = '{"type":"session","id":"saved"}\n{"type":"message","text":"durable history"}\n';
		storage.writeTextSync(sessionPath, saved);
		const diskFull = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		const writeStarted = Promise.withResolvers<void>();
		const completeWrite = Promise.withResolvers<void>();
		const open = fs.promises.open;
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const file = await open(...args);
			const input = args[0];
			if (typeof input === "string" && path.dirname(input) === tempDir.path() && input.endsWith(".tmp")) {
				const write = file.writeFile.bind(file);
				vi.spyOn(file, "writeFile").mockImplementationOnce(async (...writeArgs) => {
					await write(...writeArgs);
					writeStarted.resolve();
					await completeWrite.promise;
				});
			}
			return file;
		});

		const rewrite = storage.writeLinesAtomic(sessionPath, [
			'{"type":"session","id":"replacement"}\n',
			'{"type":"message","text":"not durably saved"}\n',
		]);
		const outcome = rewrite.then(
			() => null,
			error => error,
		);
		await writeStarted.promise;
		completeWrite.reject(diskFull);
		const error = await outcome;

		expect(await Bun.file(sessionPath).text()).toBe(saved);
		expect(error).toMatchObject({ code: "ENOSPC" });
	});
});
