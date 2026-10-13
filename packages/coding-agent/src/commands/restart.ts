import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { restartHelp as commandHelp } from "../cli/command-help";
import { runRestartCommand, type RestartAction, type RestartCommandArgs } from "../cli/restart-cli";

const ACTIONS: RestartAction[] = ["list", "request", "status", "cancel"];

export default class Restart extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default), request, status, or cancel",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		instance: Flags.string({ description: "Exact live instance ID (required for request/status/cancel)" }),
		"request-id": Flags.string({ description: "Idempotency key for request" }),
		reason: Flags.string({ description: "Optional restart reason (request)" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	static examples = [
		"omp restart list",
		"omp restart list --json",
		'omp restart request --instance <exact-instance-id> --request-id <key> --reason "deploy complete"',
		"omp restart status --instance <exact-instance-id>",
		"omp restart cancel --instance <exact-instance-id>",
	];

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Restart);
		if (argv.length > 1) throw new CliUsageError("restart accepts one action and no positional selector");
		const action = (args.action ?? "list") as RestartAction;
		const instanceId = flags.instance;
		const requestId = flags["request-id"];
		const reason = flags.reason;
		if (action === "list") {
			if (instanceId !== undefined || requestId !== undefined || reason !== undefined) {
				throw new CliUsageError("restart list accepts only --json");
			}
		} else {
			if (!instanceId) throw new CliUsageError(`restart ${action} requires --instance <exact-instance-id>`);
			if (action !== "request" && (requestId !== undefined || reason !== undefined)) {
				throw new CliUsageError(`restart ${action} does not accept --request-id or --reason`);
			}
		}
		const command: RestartCommandArgs = {
			action,
			instanceId,
			requestId,
			reason,
			json: flags.json ?? false,
		};
		await runRestartCommand(command);
	}
}
