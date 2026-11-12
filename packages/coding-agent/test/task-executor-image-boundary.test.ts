import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-tui/chat/image-loading";
import { resolveTaskImagesForFirstPrompt } from "../src/task/executor";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVQI12P8z8DwnwEJMDGgAcICAIPRAgYt167zAAAAAElFTkSuQmCC";
let fixtureRoot: string | undefined;

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
	if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

describe("task executor image boundary", () => {
	it("checks inline bytes against sha256 before forwarding them", async () => {
		const bytes = Buffer.from(PNG, "base64");
		const accepted = await resolveTaskImagesForFirstPrompt([
			{ type: "image", mimeType: "image/png", data: PNG, sha256: sha256(bytes) },
		]);
		expect(accepted.promptImages?.[0]?.data).toBe(PNG);
		expect(accepted.suffix).toBe("");

		const rejected = await resolveTaskImagesForFirstPrompt([
			{ type: "image", mimeType: "image/png", data: PNG, sha256: "0".repeat(64), index: 7 },
		]);
		expect(rejected.promptImages).toBeUndefined();
		expect(rejected.suffix).toContain("Image #7 unavailable");
		expect(rejected.suffix).toContain("SHA mismatch");
	});

	it("loads verified paths through the bounded image loader and degrades oversized files", async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-image-boundary-"));
		const validPath = path.join(fixtureRoot, "valid.png");
		await fs.writeFile(validPath, Buffer.from(PNG, "base64"));
		const bytes = await fs.readFile(validPath);
		const accepted = await resolveTaskImagesForFirstPrompt([
			{ type: "image", mimeType: "image/png", artifactPath: validPath, sha256: sha256(bytes) },
		]);
		expect(accepted.promptImages?.[0]?.data).toBe(PNG);
		expect(accepted.promptImages?.[0]?.sha256).toBe(sha256(bytes));

		const oversizedPath = path.join(fixtureRoot, "oversized.png");
		await fs.writeFile(oversizedPath, Buffer.alloc(0));
		await fs.truncate(oversizedPath, MAX_IMAGE_INPUT_BYTES + 1);
		const rejected = await resolveTaskImagesForFirstPrompt([
			{ type: "image", mimeType: "image/png", sourcePath: oversizedPath, sha256: "a".repeat(64) },
		]);
		expect(rejected.promptImages).toBeUndefined();
		expect(rejected.suffix).toContain("unavailable");
		expect(rejected.suffix).toContain("exceeds");
	});
	it("forwards the authenticated read even when the reference changes before normalization", async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-read-once-"));
		const file = path.join(fixtureRoot, "image.png");
		const bytes = Buffer.from(PNG, "base64");
		await fs.writeFile(file, bytes);
		const read = fs.readFile;
		let reads = 0;
		const probe = spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
			const result = await read(...args);
			if (args[0] === file) {
				reads++;
				await fs.writeFile(file, "changed after authenticated read");
			}
			return result;
		}) as typeof fs.readFile);
		try {
			const result = await resolveTaskImagesForFirstPrompt([
				{ type: "image", mimeType: "image/png", sourcePath: file, sha256: sha256(bytes) },
			]);
			expect(result.promptImages?.[0]?.data).toBe(PNG);
			expect(reads).toBe(1);
		} finally {
			probe.mockRestore();
		}
	});
});
