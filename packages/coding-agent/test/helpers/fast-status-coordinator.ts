import { afterEach, beforeEach, vi } from "bun:test";
import { createStatusCoordinator, statusCoordinator } from "../../../natives/native/status-coordinator.js";

/** Keep tests on the real shared coordinator path without waiting for its production cadence. */
export function useFastGitStatusCoordinator(): void {
	let restore: (() => void) | undefined;
	beforeEach(() => {
		const coordinator = createStatusCoordinator({ intervalMs: 1 });
		const request = vi
			.spyOn(statusCoordinator, "request")
			.mockImplementation((...args) => coordinator.request(...args));
		const invalidate = vi
			.spyOn(statusCoordinator, "invalidate")
			.mockImplementation(key => coordinator.invalidate(key));
		const epoch = vi.spyOn(statusCoordinator, "epoch").mockImplementation(key => coordinator.epoch(key));
		restore = () => {
			request.mockRestore();
			invalidate.mockRestore();
			epoch.mockRestore();
		};
	});
	afterEach(() => {
		restore?.();
		restore = undefined;
	});
}
