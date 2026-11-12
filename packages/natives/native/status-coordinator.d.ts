export interface StatusCoordinator {
	request<T>(
		key: string,
		snapshot: string,
		metadata: string,
		run: () => T | Promise<T>,
		signal?: AbortSignal,
		fresh?: boolean,
	): Promise<T>;
	invalidate(key?: string): void;
	epoch(key: string): number;
}

export declare function createStatusCoordinator(options?: {
	now?: () => number;
	setTimer?: (callback: () => void, delay: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	intervalMs?: number;
}): StatusCoordinator;

export declare const statusCoordinator: StatusCoordinator;
