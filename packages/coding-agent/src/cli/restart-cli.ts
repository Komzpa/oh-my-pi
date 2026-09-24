import { listRestartControls, RestartControlError, sendRestartControl } from "../restart-control";
import type { RestartControlRequest, RestartControlSnapshot } from "../task/restart-queue";

export type RestartAction = "list" | "request" | "status" | "cancel";

export interface RestartCommandArgs {
	action: RestartAction;
	instanceId?: string;
	requestId?: string;
	reason?: string;
	json: boolean;
}

function printList(snapshots: RestartControlSnapshot[]): void {
	if (snapshots.length === 0) {
		process.stdout.write("No live interactive sessions.\n");
		return;
	}
	for (const snapshot of snapshots) {
		const request = snapshot.request;
		const state = request ? `${request.state} (${request.requestId})` : "idle";
		process.stdout.write(
			`${snapshot.identity.instanceId}\t${snapshot.pid}\t${snapshot.identity.sessionId}\t${snapshot.identity.generation}\t${state}\t${snapshot.cwd}\n`,
		);
	}
}

function printSnapshot(action: RestartAction, snapshot: RestartControlSnapshot): void {
	const request = snapshot.request;
	if (action === "request") {
		process.stdout.write(
			request
				? `Restart ${request.state} for ${snapshot.identity.instanceId} (${request.requestId}).\n`
				: `Restart request accepted for ${snapshot.identity.instanceId}.\n`,
		);
		return;
	}
	if (action === "cancel") {
		process.stdout.write(
			request
				? request.state === "cancelled"
					? `Restart request ${request.requestId} cancelled.\n`
					: `Restart request ${request.requestId} is ${request.state}; it was not cancelled.\n`
				: "No restart request to cancel.\n",
		);
		return;
	}
	process.stdout.write(
		request
			? `${snapshot.identity.instanceId}: ${request.state} (${request.requestId})\n`
			: `${snapshot.identity.instanceId}: no restart request\n`,
	);
}

function findUniqueTarget(snapshots: RestartControlSnapshot[], instanceId: string): RestartControlSnapshot {
	const matches = snapshots.filter(snapshot => snapshot.identity.instanceId === instanceId);
	if (matches.length === 0)
		throw new RestartControlError("target_not_found", `No live restart target matches ${instanceId}`);
	if (matches.length > 1)
		throw new RestartControlError("invalid_request", `Restart target ${instanceId} is ambiguous`);
	return matches[0]!;
}

export async function runRestartCommand(command: RestartCommandArgs): Promise<void> {
	try {
		const snapshots = await listRestartControls();
		if (command.action === "list") {
			if (command.json) process.stdout.write(`${JSON.stringify(snapshots, null, 2)}\n`);
			else printList(snapshots);
			return;
		}

		const instanceId = command.instanceId;
		if (!instanceId) throw new RestartControlError("target_not_found", "An exact --instance target is required");
		const target = findUniqueTarget(snapshots, instanceId);
		const request: RestartControlRequest = {
			identity: target.identity,
			op: command.action,
			...(command.requestId === undefined ? {} : { requestId: command.requestId }),
			...(command.reason === undefined ? {} : { reason: command.reason }),
		};
		const updated = await sendRestartControl(request);
		if (command.json) process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
		else printSnapshot(command.action, updated);
	} catch (error) {
		const detail =
			error instanceof RestartControlError
				? `${error.code}: ${error.message}`
				: error instanceof Error
					? error.message
					: String(error);
		process.stderr.write(`error: ${detail}\n`);
		process.exitCode = 1;
	}
}
