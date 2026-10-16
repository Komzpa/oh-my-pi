import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createRpcInteractiveSessionConnection } from "../../src/modes/rpc/interactive-session";
import { RpcClient, type RpcAgentProcess } from "../../src/modes/rpc/rpc-client";

const fixture = path.join(import.meta.dir, "../fixtures/rpc-interactive-session-owner.ts");

it("rejects an outstanding turn when its owner explicitly stops the child", async () => {
	using directory = TempDir.createSync("@pi-rpc-session-owner-stop-");
	const client = new RpcClient({ cliPath: fixture, env: { RPC_OWNER_TEST_DIR: directory.path() } });
	await client.start();
	try {
		const view = await createRpcInteractiveSessionConnection(client);
		const admitted = Promise.withResolvers<void>();
		const pending = view.prompt("hold until stopped", { onPromptAdmitted: admitted.resolve });
		await admitted.promise;
		const rejected = pending.catch((error: Error) => error);
		await client.stop();
		expect(await rejected).toMatchObject({ message: "Client stopped" });
		view.disconnect();
	} finally {
		await client.stop();
	}
}, 20_000);

it("delivers sustained text while state RPC is pending and disconnect releases its listener", async () => {
	const exit = Promise.withResolvers<number>();
	let output!: ReadableStreamDefaultController<Uint8Array>;
	const encode = (frame: object) => new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
	let requests = 0;
	let heldId: string | undefined;
	const send = (frame: object) => output.enqueue(encode(frame));
	const process: RpcAgentProcess = {
		stdin: {
			write(raw: string | Uint8Array) {
				const command = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
				if (command.type === "get_state") {
					requests++;
					if (requests <= 2)
						send({
							id: command.id,
							type: "response",
							command: "get_state",
							success: true,
							data: { isStreaming: true, isCompacting: false, hasPostPromptWork: false },
						});
					else heldId = command.id;
				}
			},
		},
		stdout: new ReadableStream({
			start(controller) {
				output = controller;
				send({ type: "ready" });
			},
		}),
		peekStderr: () => "",
		kill: () => exit.resolve(0),
		exited: exit.promise,
	};
	const client = new RpcClient({ spawn: () => process });
	await client.start();
	try {
		const view = await createRpcInteractiveSessionConnection(client);
		let events = 0;
		const survivor = await createRpcInteractiveSessionConnection(client);
		view.subscribe(() => {
			view.disconnect();
		});
		survivor.subscribe(() => events++);
		const pending = view.refresh();
		for (let index = 0; index < 200; index++) send({ type: "message_update", index });
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		expect(events).toBe(200);
		expect(requests).toBe(3);
		survivor.disconnect();
		for (let index = 0; index < 200; index++) send({ type: "message_update", index });
		send({
			id: heldId,
			type: "response",
			command: "get_state",
			success: true,
			data: { isStreaming: false, isCompacting: false, hasPostPromptWork: false },
		});
		await pending;
		expect(events).toBe(200);
		expect(requests).toBe(3);
	} finally {
		await client.stop();
	}
});

it("keeps a child turn alive across view disconnect and reconnects with fresh state without replay", async () => {
	using directory = TempDir.createSync("@pi-rpc-session-connection-");
	const client = new RpcClient({ cliPath: fixture, env: { RPC_OWNER_TEST_DIR: directory.path() } });
	await client.start();
	try {
		const sessionFile = await Bun.file(directory.join("session-file")).text();
		const draft = Bun.file(path.join(sessionFile.slice(0, -".jsonl".length), "draft.txt"));
		expect(await draft.text()).toBe("unsent черновик 🐈");
		const first = await createRpcInteractiveSessionConnection(client);
		expect(first.isStreaming).toBe(false);
		let admissions = 0;
		const pending = first.prompt("продолжай 🐈", {
			runCommands: false,
			streamingBehavior: "steer",
			onPromptAdmitted: () => admissions++,
		});
		// Bounded polling observes the real child entering its controlled provider call.
		for (let i = 0; !(await Bun.file(directory.join("started.json")).exists()) && i < 500; i++) await Bun.sleep(10);
		const started = await Bun.file(directory.join("started.json")).json();
		expect(started.calls).toBe(1);
		await first.refresh();
		expect(first.isStreaming).toBe(true);
		const discardedEvents: string[] = [];
		first.subscribe(event => discardedEvents.push(event.type));
		first.disconnect();
		first.disconnect();
		expect(() => first.prompt("must not replay")).toThrow("disconnected");
		const second = await createRpcInteractiveSessionConnection(client);
		expect(second.isStreaming).toBe(true);
		expect(await Bun.file(directory.join("effect.json")).exists()).toBe(false);
		second.disconnect();
		await Bun.write(directory.join("release"), "continue");
		expect(await pending).toBe(true);
		expect(admissions).toBe(1);
		const third = await createRpcInteractiveSessionConnection(client);
		expect(third.isStreaming).toBe(false);
		expect(third.isCompacting).toBe(false);
		expect(third.hasPostPromptWork).toBe(false);
		expect(await Bun.file(directory.join("effect.json")).json()).toEqual(started);
		expect(discardedEvents).toEqual([]);
		expect(await draft.text()).toBe("unsent черновик 🐈");
		const messages = await client.getMessages();
		expect(
			messages.filter(
				message => message.role === "user" && JSON.stringify(message.content).includes("продолжай 🐈"),
			),
		).toHaveLength(1);
		third.disconnect();
	} finally {
		await client.stop();
	}
}, 20_000);
