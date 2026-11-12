import type { ActiveGate } from "./todo_dispatch";

export function zeroActiveGate(remedy: string): ActiveGate {
	return { id: "zero-active", remedy, satisfies: call => call.name === "task" || call.name === "todo" };
}
