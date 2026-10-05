import type { AgentSession } from "../session/agent-session";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { resolveRpcSkillInvocation, runRpcSkillCommand } from "../modes/rpc/rpc-mode";

export interface PeerCommandReceipt {
	outcome: "executed" | "queued";
	reason?: string;
}

/** Resolve against the target's real command registries, never model interpretation. */
export async function executePeerSlashCommand(session: AgentSession, text: string): Promise<PeerCommandReceipt | null> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return null;
	const output: string[] = [];
	const skill = resolveRpcSkillInvocation(session, text);
	// Namespaced commands are one token in the real target registries.
	const name = text.slice(1).split(" ", 1)[0]!;
	const extensionCommand = session.extensionRunner?.getCommand(name) !== undefined;
	const registered =
		extensionCommand ||
		session.customCommands.some(loaded => loaded.command.name === name) ||
		session.slashCommands.some(command => command.name === name) ||
		session.promptTemplates.some(template => template.name === name);
	const builtin = name !== parsed.name && registered ? undefined : lookupBuiltinSlashCommand(parsed.name);
	let prompt = text;
	if (skill) {
		const admitted = Promise.withResolvers<PeerCommandReceipt>();
		const completed = runRpcSkillCommand(session, skill, "followUp", undefined, () =>
			admitted.resolve({ outcome: "queued" }),
		).then((): PeerCommandReceipt => ({ outcome: "executed" }));
		return Promise.race([admitted.promise, completed]);
	}
	if (builtin) {
		if (!builtin.handle) throw new Error(`/${builtin.name} requires interactive user input`);
		if (parsed.args && !builtin.allowArgs) throw new Error(`/${builtin.name} does not accept arguments`);
		const result = await executeAcpBuiltinSlashCommand(text, {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: message => {
				output.push(message);
				session.emitNotice("info", message, "peer-command");
			},
			refreshCommands: () => session.refreshSkillsAndCommands(),
			reloadPlugins: async () => {
				throw new Error("Plugin reload requires the target session's host command context");
			},
		});
		if (result === false) throw new Error(`/${builtin.name} could not be dispatched`);
		if (!("prompt" in result))
			return { outcome: "executed", ...(output.length ? { reason: output.join("\n") } : {}) };
		prompt = result.prompt;
	} else if (!registered) {
		return null;
	}
	const admitted = Promise.withResolvers<PeerCommandReceipt>();
	const completed = session
		.prompt(prompt, {
			streamingBehavior: "followUp",
			throwOnDrop: true,
			throwOnCommandError: true,
			// Extension admission precedes the handler, so it is not execution proof.
			...(!extensionCommand ? { onPromptAdmitted: () => admitted.resolve({ outcome: "queued" }) } : {}),
		})
		.then((forwarded): PeerCommandReceipt => ({ outcome: forwarded ? "queued" : "executed" }));
	return Promise.race([admitted.promise, completed]);
}
