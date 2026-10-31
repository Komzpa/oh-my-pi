import { publishPeerSession } from "../../src/collab/registry";
import type { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";

const dir = process.argv[2];
if (!dir) throw new Error("peer registry directory is required");
const registry = new AgentRegistry();
const irc = {
	async send(message: { body: string }) {
		process.stdout.write(`${JSON.stringify({ delivered: message.body })}\n`);
		return { to: "Main", outcome: "injected" as const };
	},
} as unknown as IrcBus;
const publication = await publishPeerSession({
	dir,
	sessionId: "blocked-worker-session-12345678",
	cwd: "/work/blocked-peer",
	title: () => "Blocked peer worker",
	registry,
	irc,
	isBusy: () => true,
});
process.stdout.write(`${JSON.stringify({ ready: true, instanceId: publication.instanceId })}\n`);
// The parent sends SIGSTOP here. This loop also lets a signal-free manual run
// demonstrate that no socket callback runs while the event loop is occupied.
const until = Date.now() + 2_500;
while (Date.now() < until) {}
if (process.argv[3] === "exit") {
	await publication.close();
	process.stdout.write(`${JSON.stringify({ closed: true })}\n`);
	process.exit(0);
}
await publication.drainInbox();
await publication.close();
