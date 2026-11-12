import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("fenced async storage publication", () => {
	it("publishes through the async Windows replacement fallback without leaving a backup", async () => {
		using temp = TempDir.createSync("@pi-rewrite-eperm-");
		const file = path.join(temp.path(), "journal.jsonl");
		await Bun.write(file, "old\n");
		class EpermStorage extends FileSessionStorage {
			calls = 0;
			override async rename(from: string, to: string): Promise<void> {
				if (this.calls++ === 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
				await super.rename(from, to);
			}
		}
		await new EpermStorage().writeTextAtomic(file, "new\n", { expectedSize: 4, fencedAsyncPublish: true });
		expect(await Bun.file(file).text()).toBe("new\n");
		expect(await fs.readdir(temp.path())).toEqual(["journal.jsonl"]);
	});
});
