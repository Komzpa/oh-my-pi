export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AttemptJournalState =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "aborted"
	| "cancelled"
	| "unknown"
	| "legacy-unresolved";
export type AttemptJournalRestartState =
	| "queued"
	| "draining"
	| "ready"
	| "restoring"
	| "completed"
	| "failed"
	| "cancelled";
export interface AttemptJournalOwner {
	ownerName: string;
	workerId: string;
	childSessionId: string;
	leaseEpoch: number;
}
export interface AttemptJournalResult {
	artifactUri: string;
	sha256: string;
	mediaType: string;
	executionOutcome: "success" | "failure";
	verdict?: JsonValue;
}
export interface AttemptJournalSource {
	fingerprint: string;
	entryIds: string[];
	[key: string]: JsonValue;
}
export interface AttemptJournalCAS {
	expectedRevision: number;
	expectedAttempt: number;
	expectedGeneration: number;
	expectedLeaseEpoch: number;
	expectedRowRevision?: number;
}
export interface AttemptJournalTaskFields {
	taskId: string;
	attempt: number;
	generation: number;
	state: AttemptJournalState;
	owner: AttemptJournalOwner | null;
	rowId?: string;
	purpose?: "work" | "audit" | "observe";
}
export type AttemptJournalTaskKind =
	| "AttemptQueued"
	| "AttemptStarted"
	| "ResultCommitted"
	| "AttemptAborted"
	| "AttemptCancelled"
	| "GenerationAdvanced"
	| "OwnerTransferred"
	| "CheckpointRecorded"
	| "LegacyImported"
	| "LegacyAdopted";
export type AttemptJournalTaskCommand = AttemptJournalTaskFields & { commandId: string } & (
		| (AttemptJournalCAS &
				(
					| {
							kind: "ResultCommitted";
							state: "succeeded" | "failed";
							result: AttemptJournalResult;
							artifact?: { data: string; mediaType: string };
					  }
					| {
							kind: "LegacyAdopted";
							source: AttemptJournalSource;
							result?: AttemptJournalResult;
							checkpoint?: string;
							artifact?: { data: string; mediaType: string };
					  }
					| { kind: "CheckpointRecorded"; checkpoint: string }
					| { kind: "AttemptQueued"; state: "queued"; owner: AttemptJournalOwner }
					| { kind: "AttemptStarted"; state: "running" }
					| { kind: "AttemptAborted"; state: "aborted" }
					| { kind: "AttemptCancelled"; state: "cancelled" }
					| { kind: "GenerationAdvanced" | "OwnerTransferred" }
				))
		| (Partial<AttemptJournalCAS> & {
				kind: "LegacyImported";
				source: AttemptJournalSource;
				result?: AttemptJournalResult;
				checkpoint?: string;
				artifact?: { data: string; mediaType: string };
		  })
	);
export interface AttemptJournalAttemptRef {
	taskId: string;
	attempt: number;
}
export type AttemptJournalCommand =
	| AttemptJournalTaskCommand
	| {
			kind: "RestartTransition";
			commandId: string;
			requestId: string;
			state: AttemptJournalRestartState;
			affectedAttempts: AttemptJournalAttemptRef[];
			reason?: string;
			accountedChildren?: string[];
	  }
	| { kind: "NoticeApplied"; commandId: string; childSessionId: string; requestId: string; terminalEventSeq: number }
	| { kind: "ImportCompleted"; commandId: string; sourceFingerprint: string }
	| {
			kind: "LegacyRestartImported";
			commandId: string;
			requestId: string;
			state: AttemptJournalRestartState | "unknown";
			affectedAttempts: AttemptJournalAttemptRef[];
			source: AttemptJournalSource;
	  }
	| { kind: "WriterEpochStarted"; commandId: string };
export interface AttemptJournalEnvelope {
	v: 1;
	leadSessionId: string;
	seq: number;
	writerEpoch: number;
	at: string;
}
export type AttemptJournalEvent = AttemptJournalCommand & AttemptJournalEnvelope;
export interface AttemptJournalAttempt extends AttemptJournalTaskFields {
	revision: number;
	leaseEpoch: number;
	result?: AttemptJournalResult;
	checkpoint?: string;
	terminalSeq?: number;
	source?: AttemptJournalSource;
}
export interface AttemptJournalTask {
	taskId: string;
	revision: number;
	currentAttempt: number;
	attempts: Record<string, AttemptJournalAttempt>;
}
export interface AttemptJournalRow {
	rowId: string;
	revision: number;
	currentWork?: AttemptJournalAttemptRef;
	owner: AttemptJournalOwner | null;
	stageTaskId?: string;
}
export interface AttemptJournalRestart {
	requestId: string;
	state: AttemptJournalRestartState | "unknown";
	affectedAttempts: AttemptJournalAttemptRef[];
	seq: number;
	reason?: string;
	accountedChildren?: string[];
	source?: AttemptJournalSource;
}
export interface AttemptJournalProjection {
	leadSessionId: string;
	appliedSeq: number;
	writerEpoch: number;
	tasks: Record<string, AttemptJournalTask>;
	rows: Record<string, AttemptJournalRow>;
	restarts: Record<string, AttemptJournalRestart>;
	notices: Record<string, { appliedSeq: number; keys: string[] }>;
	imports: string[];
	commands: Record<string, { payload: string; event: AttemptJournalEvent }>;
}
