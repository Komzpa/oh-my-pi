import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { ToolResourceScope } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe.skipIf(Bun.env.PI_PYTHON_INTEGRATION !== "1")("Python kernel resource scope", () => {
	it("retains a bounded kernel across cells and closes its scope once on shutdown", async () => {
		using tempDir = TempDir.createSync("@python-kernel-scope-");
		const close = vi.spyOn(ToolResourceScope.prototype, "close");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		let output = "";
		try {
			await kernel.execute(
				process.platform === "linux"
					? "import pathlib\nretained = 41\nprint(pathlib.Path('/proc/self/cgroup').read_text())"
					: "retained = 41",
				{
					onChunk: text => {
						output += text;
					},
				},
			);
			if (process.platform === "linux") {
				const cgroup = output.trim().split("::")[1];
				let cgroupPath = path.join("/sys/fs/cgroup", cgroup);
				let tasksMax = Number.POSITIVE_INFINITY;
				while (cgroupPath !== "/sys/fs/cgroup") {
					const tasks = Number(await fs.readFile(path.join(cgroupPath, "pids.max"), "utf8"));
					if (Number.isFinite(tasks)) tasksMax = Math.min(tasksMax, tasks);
					cgroupPath = path.dirname(cgroupPath);
				}
				expect(tasksMax).toBeLessThanOrEqual(500);
			}
			output = "";
			const result = await kernel.execute("print(retained + 1)", {
				onChunk: text => {
					output += text;
				},
			});
			expect(result.status).toBe("ok");
			expect(output.trim()).toBe("42");
			expect(close).not.toHaveBeenCalled();
		} finally {
			await kernel.shutdown();
		}
		await kernel.shutdown();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes the owned scope when the Python runner exits unexpectedly", async () => {
		using tempDir = TempDir.createSync("@python-kernel-scope-exit-");
		const close = vi.spyOn(ToolResourceScope.prototype, "close");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await kernel.execute("import os\nos._exit(17)");
			expect(result.kernelKilled).toBe(true);
			expect(kernel.isAlive()).toBe(false);
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			await kernel.shutdown();
		}
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("fails closed and releases the scope when wrapping the command fails", async () => {
		using tempDir = TempDir.createSync("@python-kernel-scope-failure-");
		const close = vi.spyOn(ToolResourceScope.prototype, "close");
		vi.spyOn(ToolResourceScope.prototype, "wrapCommand").mockImplementation(() => {
			throw new Error("test resource boundary unavailable");
		});
		const spawn = vi.spyOn(Bun, "spawn");
		await expect(PythonKernel.start({ cwd: tempDir.path() })).rejects.toThrow("test resource boundary unavailable");
		expect(spawn).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("releases its scope when kernel initialization is cancelled", async () => {
		using tempDir = TempDir.createSync("@python-kernel-scope-cancel-");
		const close = vi.spyOn(ToolResourceScope.prototype, "close");
		const controller = new AbortController();
		controller.abort(new Error("test startup cancelled"));
		await expect(PythonKernel.start({ cwd: tempDir.path(), signal: controller.signal })).rejects.toThrow(
			"test startup cancelled",
		);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("releases its scope when spawning the wrapped command fails", async () => {
		using tempDir = TempDir.createSync("@python-kernel-scope-spawn-");
		const close = vi.spyOn(ToolResourceScope.prototype, "close");
		const wrap = vi.spyOn(ToolResourceScope.prototype, "wrapCommand");
		const spawn = vi.spyOn(Bun, "spawn").mockImplementationOnce(() => {
			throw new Error("test wrapped spawn failed");
		});
		await expect(PythonKernel.start({ cwd: tempDir.path() })).rejects.toThrow("test wrapped spawn failed");
		expect(wrap).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});
});
