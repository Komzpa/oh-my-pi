import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../src/config/settings";
import { getProviderSemaphore, wrapStreamFnWithProviderConcurrency } from "../../src/task/provider-concurrency";
import type { ThreadService } from "../../src/thread/services";
import { THREAD_SERVICES } from "../../src/thread/services/index";
import { createAssistantMessage } from "../helpers/agent-session-setup";

export interface ProviderProbe {
	start(id: string, provider: string, limit: number, signal?: AbortSignal, throws?: boolean): Promise<void>;
	finish(id: string, error?: boolean): Promise<void>;
	resize(limit: number): Promise<void>;
	crash(): Promise<void>;
	state(): Promise<{ attempted: string[]; admitted: string[] }>;
}

const streams = new Map<string, AssistantMessageEventStream>();
const attempted: string[] = [];
const admitted: string[] = [];
const probe: ProviderProbe = {
	async start(id, provider, limit, signal, throws) {
		attempted.push(id);
		const stream = new AssistantMessageEventStream();
		streams.set(id, stream);
		const base: StreamFn = () => {
			if (throws) throw new Error("provider rejected before returning a stream");
			admitted.push(id);
			return stream;
		};
		const send = wrapStreamFnWithProviderConcurrency(
			Settings.isolated({ "providers.ollama-cloud.maxConcurrency": limit }),
			base,
		);
		const model = buildModel({
			id: "provider-slot-probe",
			name: "Provider slot probe",
			api: "openai-completions",
			provider,
			baseUrl: "http://unused.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});
		await send(model, { messages: [] }, { signal });
	},
	async finish(id, error) {
		const stream = streams.get(id);
		if (!stream) throw new Error(`Unknown probe stream ${id}`);
		streams.delete(id);
		if (error) stream.fail(new Error("provider stream failed"));
		else stream.end(createAssistantMessage("finished"));
	},
	async resize(limit) {
		getProviderSemaphore(Settings.isolated({ "providers.ollama-cloud.maxConcurrency": limit }), "ollama-cloud");
	},
	async crash() {
		setTimeout(() => {
			throw new Error("provider probe owner crash");
		}, 0);
	},
	async state() {
		return { attempted: [...attempted], admitted: [...admitted] };
	},
};

// Only this disposable worker realm is modified. The real entry boots the full service list.
(THREAD_SERVICES as ThreadService[]).push({
	name: "provider-probe",
	async boot(globals) {
		await (globals as { ready(probe: ProviderProbe): Promise<void> }).ready(probe);
	},
});
