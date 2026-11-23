import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it.each([false, true])(
	"normal interactive launcher retains the runtime connection (active turn: %j)",
	async hold => {
		using directory = TempDir.createSync("@pi-main-interactive-owner-");
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/interactive-launcher-owner.ts")],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, LAUNCHER_TEST_DIR: directory.path(), LAUNCHER_TEST_HOLD: hold ? "1" : "0" },
			},
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		expect({ exit: await child.exited, stdout: await stdout, stderr: await stderr }).toMatchObject({ exit: 0 });
		const result = await Bun.file(directory.join("result.json")).json();
		if (hold) {
			expect(result).toMatchObject({
				routed: ["prompt:running before view detach"],
				aliveAtDetach: true,
				calls: 1,
				effects: 1,
				receivedAfterDetach: 0,
			});
		} else {
			expect(result).toMatchObject({
				routed: ["prompt:startup first", "prompt:startup second", "custom:launcher-custom", "prompt:typed 🐈"],
				aliveAtDetach: false,
				calls: 4,
				effects: 4,
				receivedAfterDetach: 0,
			});
		}
	},
	20_000,
);
