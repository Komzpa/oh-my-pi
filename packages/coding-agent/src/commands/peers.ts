import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { peersHelp as commandHelp } from "../cli/command-help";
import { runPeerListCommand, runPeerSendCommand } from "../cli/peers-cli";

async function readMessage(raw: string | undefined): Promise<string> {
	if (!raw) throw new CliUsageError("peers send requires text or @file");
	if (!raw.startsWith("@")) return raw;
	const file = raw.slice(1);
	if (!file) throw new CliUsageError("peers send @file requires a file path");
	return Bun.file(file).text();
}

export default class Peers extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default) or send",
			required: false,
			options: ["list", "send"],
		}),
		target: Args.string({ description: "Target session id, prefix, cwd, or title (send only)", required: false }),
		text: Args.string({ description: "Message text or @file (send only)", required: false }),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit deterministic machine-readable JSON", default: false }),
		agent: Flags.string({ description: "Agent id inside the target session process", required: false }),
	};

	static examples = [
		"omp peers list",
		"omp peers list --json",
		"omp peers send sunbim 'status?'",
		"omp peers send /home/kom/proj/sunbim/datacenter-decision-graph @message.txt --agent Main",
	];

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Peers);
		const action = args.action ?? "list";
		if (action === "list") {
			if (argv.length > 1 || flags.agent) {
				throw new CliUsageError("peers list accepts no selector or --agent (usage: peers list [--json])");
			}
			await runPeerListCommand({ json: flags.json });
			return;
		}
		if (argv.length < 3 || !args.target) {
			throw new CliUsageError("peers send requires target and text (usage: peers send <target> <text|@file>)");
		}
		const exitCode = await runPeerSendCommand({
			target: args.target,
			text: await readMessage(argv.slice(2).join(" ")),
			agent: flags.agent,
			json: flags.json,
		});
		process.exitCode = exitCode;
	}
}
