import type { Browser, LaunchOptions, PuppeteerNode } from "puppeteer-core";

/** Prefix before exec so Chromium's initial renderers inherit both priorities. */
export function backgroundBrowserCommand(executablePath: string, args: string[]): string[] {
	if (process.platform !== "linux") return [executablePath, ...args];
	const nice = Bun.which("nice");
	const ionice = Bun.which("ionice");
	if (!nice || !ionice) throw new Error("Linux browser launches require nice and ionice on PATH.");
	return [nice, "-n", "19", ionice, "-c2", "-n7", executablePath, ...args];
}

/** Keep Puppeteer's own process ownership and CDP setup, without a post-spawn race. */
export async function launchBackgroundBrowser(puppeteer: PuppeteerNode, options: LaunchOptions): Promise<Browser> {
	if (process.platform !== "linux") return puppeteer.launch(options);
	if (!options.executablePath) throw new Error("Background browser launch requires an executable path.");
	// defaultArgs is typed as possibly async across puppeteer-core's overloads; await keeps args a plain string[].
	let args = options.ignoreDefaultArgs === true ? (options.args ?? []) : await puppeteer.defaultArgs(options);
	if (Array.isArray(options.ignoreDefaultArgs)) {
		const ignored = options.ignoreDefaultArgs;
		args = args.filter(arg => !ignored.includes(arg));
	}
	const [executablePath, ...backgroundArgs] = backgroundBrowserCommand(options.executablePath, args);
	return puppeteer.launch({ ...options, executablePath, args: backgroundArgs, ignoreDefaultArgs: true });
}
