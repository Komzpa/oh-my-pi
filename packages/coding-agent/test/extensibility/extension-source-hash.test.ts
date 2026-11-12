import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bindPreparedExtensions, loadExtensions } from "../../src/extensibility/extensions/loader";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
	const base = path.resolve(import.meta.dir, "../../../../tmp");
	await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "extension-hash-"));
	roots.push(root);
	return root;
}

const versionA = 'export default function(pi) { pi.setLabel("version A"); }\n';
const versionB = 'export default function(pi) { pi.setLabel("version B"); }\n';
const hash = (source: string) => new Bun.CryptoHasher("sha256").update(source).digest("hex");

describe("extension load-time content hashes", () => {
	it("retains loaded version A after install replaces it with B, including prepared rebinds", async () => {
		const root = await fixture();
		const entry = path.join(root, "router.ts");
		await Bun.write(entry, versionA);
		const loaded = await loadExtensions([entry], root);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions[0]?.sourceHash).toBe(hash(versionA));
		await Bun.write(entry, versionB);
		expect(loaded.extensions[0]?.sourceHash).not.toBe(hash(await Bun.file(entry).text()));
		const rebound = await bindPreparedExtensions(loaded.preparedExtensions ?? [], root);
		expect(rebound.extensions[0]?.label).toBe("version A");
		expect(rebound.extensions[0]?.sourceHash).toBe(hash(versionA));
		const fresh = await loadExtensions([entry], root);
		expect(fresh.extensions[0]?.label).toBe("version B");
		expect(fresh.extensions[0]?.sourceHash).toBe(hash(versionB));
	});

	it("keeps an identical installed extension hash current", async () => {
		const root = await fixture();
		const entry = path.join(root, "router.ts");
		await Bun.write(entry, versionA);
		const loaded = await loadExtensions([entry], root);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions[0]?.sourceHash).toBe(hash(await Bun.file(entry).text()));
	});
});
