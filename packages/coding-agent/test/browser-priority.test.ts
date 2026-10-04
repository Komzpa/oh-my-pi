import { expect, test } from "bun:test";
import { backgroundBrowserCommand, launchBackgroundBrowser } from "../src/tools/browser/priority";
import type { LaunchOptions, PuppeteerNode } from "puppeteer-core";

test.skipIf(process.platform !== "linux")("browser argv sets priority before exec and preserves parent", async () => {
	const before = await Bun.file(`/proc/${process.pid}/stat`).text();
	const child = Bun.spawn(backgroundBrowserCommand("/bin/sh", ["-c", "cat /proc/$$/stat; ionice -p $$"]), {
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = await new Response(child.stdout).text();
	expect(await child.exited).toBe(0);
	const [stat, io] = output.trim().split("\n");
	const nice = (value: string) =>
		value
			.slice(value.lastIndexOf(")") + 1)
			.trim()
			.split(/\s+/)[16];
	expect(nice(stat!)).toBe("19");
	expect(io).toBe("best-effort: prio 7");
	expect(nice(await Bun.file(`/proc/${process.pid}/stat`).text())).toBe(nice(before));
});

test.skipIf(process.platform !== "linux")(
	"Puppeteer retains pipe and filtered defaults under priority prefix",
	async () => {
		let received: LaunchOptions | undefined;
		const puppeteer = {
			defaultArgs: () => ["--no-sandbox", "--headless", "--user-data-dir=/tmp/profile"],
			launch: async (options: LaunchOptions) => {
				received = options;
				return {};
			},
		} as unknown as PuppeteerNode;
		await launchBackgroundBrowser(puppeteer, {
			executablePath: "/browser with spaces",
			pipe: true,
			ignoreDefaultArgs: ["--no-sandbox"],
		});
		expect(received?.pipe).toBe(true);
		expect(received?.ignoreDefaultArgs).toBe(true);
		const ionice = Bun.which("ionice") ?? "ionice";
		expect(received?.args).toEqual([
			"-n",
			"19",
			ionice,
			"-c2",
			"-n7",
			"/browser with spaces",
			"--headless",
			"--user-data-dir=/tmp/profile",
		]);
	},
);
