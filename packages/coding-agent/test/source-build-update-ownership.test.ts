import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import * as buildService from "../src/cli/build-service";
import { runAutoUpdate } from "../src/cli/auto-update";
import * as updateCli from "../src/cli/update-cli";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { checkForNewVersion } from "../src/main";
import * as sharedWorker from "../src/subprocess/shared-worker";

const BUILT = {
	status: "built",
	source_tree: "tree-0123",
	candidate_sha256: "ab".repeat(32),
	version: "1.2.3",
};

let dir = "";
let binary = "";
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");

/** A compiled-looking omp in a temp dir; `record` is the sibling build.json, when any. */
function installBinary(record?: unknown): void {
	fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
	if (record !== undefined) fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify(record));
}

describe("source build ownership (sibling build.json)", () => {
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "source-build-"));
		binary = path.join(dir, "omp");
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		Object.defineProperty(process, "execPath", { value: binary, configurable: true, writable: true });
		vi.spyOn(utils, "getUpdateStateDir").mockReturnValue(path.join(dir, "state"));
		resetSettingsForTest();
		await Settings.init({ agentDir: dir, cwd: dir });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (execPathDescriptor) Object.defineProperty(process, "execPath", execPathDescriptor);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe("self-update decision", () => {
		it("denies a binary with a complete built record, and allows the same binary without or with a partial one", async () => {
			installBinary();
			expect(await updateCli.canSelfUpdate()).toBe(true);

			fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ ...BUILT, status: "pending" }));
			expect(await updateCli.canSelfUpdate()).toBe(true);
			fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ ...BUILT, candidate_sha256: undefined }));
			expect(await updateCli.canSelfUpdate()).toBe(true);
			fs.writeFileSync(path.join(dir, "build.json"), "{not json");
			expect(await updateCli.canSelfUpdate()).toBe(true);

			fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify(BUILT));
			expect(await updateCli.canSelfUpdate()).toBe(false);
		});

		it("keeps Tern-managed installs denied independently of build.json", async () => {
			fs.mkdirSync(path.join(dir, "versions"));
			binary = path.join(dir, "versions", "1.0.0");
			Object.defineProperty(process, "execPath", { value: binary, configurable: true, writable: true });
			fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
			fs.writeFileSync(path.join(dir, "manager.json"), JSON.stringify({ manager: "tern", name: "Tern" }));
			expect(await updateCli.canSelfUpdate()).toBe(false);
		});
	});

	describe("background update check", () => {
		it("offers no version to a source build and still asks the build service of a release binary", async () => {
			const fetchSpy = spyOn(buildService, "fetchBuild").mockResolvedValue({ version: "99.0.0" } as never);
			installBinary();
			expect(await checkForNewVersion("1.0.0")).toBe("99.0.0");
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			installBinary(BUILT);
			expect(await checkForNewVersion("1.0.0")).toBeUndefined();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("background self-update", () => {
		function sinks() {
			return { notify: vi.fn(), show: vi.fn() };
		}

		it("starts a worker for a release binary", async () => {
			installBinary();
			const spawn = spyOn(sharedWorker, "spawnDetached").mockReturnValue({
				proc: { exited: Promise.resolve(0) },
			} as never);
			await runAutoUpdate(Promise.resolve("99.0.0"), sinks());
			expect(spawn).toHaveBeenCalledTimes(1);
		});

		it("starts no worker and shows no update banner for a source build", async () => {
			installBinary(BUILT);
			const spawn = spyOn(sharedWorker, "spawnDetached");
			const s = sinks();
			await runAutoUpdate(Promise.resolve(undefined), s);
			// A version the check could never offer a source build still must not start a worker.
			await runAutoUpdate(Promise.resolve("99.0.0"), s);
			expect(spawn).not.toHaveBeenCalled();
			expect(s.show).not.toHaveBeenCalled();
		});
	});

	describe("manual update", () => {
		it("refuses a source build before reading settings or the network", async () => {
			installBinary(BUILT);
			vi.spyOn(utils, "$which").mockReturnValue(binary);
			const init = spyOn(Settings, "init");
			const logged = spyOn(console, "log").mockImplementation(() => {});
			const outcome = await updateCli.runUpdateCommand({ force: false, check: true });
			expect(outcome.kind).toBe("unsupported");
			expect(init).not.toHaveBeenCalled();
			logged.mockRestore();
		});

		it("proceeds past the ownership gate for the same binary without a build record", async () => {
			installBinary();
			vi.spyOn(utils, "$which").mockReturnValue(binary);
			spyOn(console, "log").mockImplementation(() => {});
			const init = spyOn(Settings, "init").mockRejectedValue(new Error("reached settings"));
			await expect(updateCli.runUpdateCommand({ force: false, check: true })).rejects.toThrow("reached settings");
			expect(init).toHaveBeenCalledTimes(1);
		});
	});
});
