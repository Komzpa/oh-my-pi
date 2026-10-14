import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { repairBorrowedWorkspaceNodeModules } from "../../src/task/workspace-dependencies";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function readWorkerImports(workerRoot: string): Promise<{ local: string; external: string }> {
	const entry = path.join(workerRoot, "packages", "app", "resolve.mjs");
	const child = Bun.spawn([process.execPath, "run", entry], {
		cwd: workerRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`worker import failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as { local: string; external: string };
}

async function makeCheckout(root: string, source: string): Promise<void> {
	await fs.mkdir(path.join(root, "packages", "ai"), { recursive: true });
	await fs.mkdir(path.join(root, "packages", "app"), { recursive: true });
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
	await fs.writeFile(
		path.join(root, "packages", "ai", "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-ai", type: "module", exports: "./index.js" }),
	);
	await fs.writeFile(
		path.join(root, "packages", "ai", "index.js"),
		`export const source = ${JSON.stringify(source)};\n`,
	);
	await fs.writeFile(
		path.join(root, "packages", "app", "resolve.mjs"),
		'import { source as local } from "@oh-my-pi/pi-ai";\nimport { source as external } from "safe-cache";\nconsole.log(JSON.stringify({ local, external }));\n',
	);
}

describe("borrowed workspace dependencies", () => {
	it("resolves local packages from the worker checkout and keeps cached external packages", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-borrowed-workspace-"));
		roots.push(root);
		const oldCheckout = path.join(root, "checkout-old");
		const currentCheckout = path.join(root, "checkout-current");
		const workerCheckout = path.join(root, "worker-current");
		await makeCheckout(oldCheckout, "checkout-old");
		await makeCheckout(currentCheckout, "checkout-current");

		const oldNodeModules = path.join(oldCheckout, "node_modules");
		await fs.mkdir(path.join(oldNodeModules, "@oh-my-pi"), { recursive: true });
		await fs.symlink(
			path.join(oldCheckout, "packages", "ai"),
			path.join(oldNodeModules, "@oh-my-pi", "pi-ai"),
			"dir",
		);
		await fs.mkdir(path.join(oldNodeModules, "safe-cache"), { recursive: true });
		await fs.writeFile(
			path.join(oldNodeModules, "safe-cache", "package.json"),
			JSON.stringify({ name: "safe-cache", type: "module", exports: "./index.js" }),
		);
		await fs.writeFile(
			path.join(oldNodeModules, "safe-cache", "index.js"),
			'export const source = "external-cache";\n',
		);
		await fs.symlink(oldNodeModules, path.join(currentCheckout, "node_modules"), "dir");
		await fs.cp(currentCheckout, workerCheckout, { recursive: true });

		const baseline = await readWorkerImports(workerCheckout);
		expect(baseline).toEqual({ local: "checkout-old", external: "external-cache" });

		await repairBorrowedWorkspaceNodeModules(workerCheckout);

		expect(await fs.lstat(path.join(workerCheckout, "node_modules")).then(stat => stat.isSymbolicLink())).toBe(false);
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "@oh-my-pi", "pi-ai"))).toBe(
			path.join(workerCheckout, "packages", "ai"),
		);
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "safe-cache"))).toBe(
			path.join(oldNodeModules, "safe-cache"),
		);
		expect(await readWorkerImports(workerCheckout)).toEqual({
			local: "checkout-current",
			external: "external-cache",
		});
	});
});
