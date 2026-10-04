// Grievance 567: gate-refused rework must deliver nothing to idle owners.
// Fails before fix (agent:// allowed), passes after (agent:// blocked while escalated).
import { expect, test } from "bun:test";
import { decideGateCall } from "./todo_dispatch";
import type { ActiveGate } from "./todo_dispatch";

const unread: readonly ActiveGate[] = [
  {
    id: "unread-receipts",
    remedy: "answer it in a todo call",
    satisfies: (call) => call.name === "todo",
  },
];

test("567: refused agent rework delivers nothing while unread-receipts stands", () => {
  const v = decideGateCall(
    { name: "write", arguments: { path: "agent://HallwayAudioMesh", content: "rework: fix env" } },
    unread,
  );
  expect(v.allowed).toBe(false);
  expect(v.reason ?? "").toContain("blocked by 1 gate(s): unread-receipts");
});

test("567: refused task rework spawns nothing while unread-receipts stands", () => {
  const v = decideGateCall(
    { name: "task", arguments: { tasks: [{ name: "HallwayAudioMesh", task: "rework env" }] } },
    unread,
  );
  expect(v.allowed).toBe(false);
  expect(v.reason ?? "").toContain("unread-receipts");
});

test("567 control: kill still allowed; remedy todo allowed; no-gate rework allowed", () => {
  expect(
    decideGateCall({ name: "write", arguments: { path: "proc://HallwayAudioMesh/kill" } }, unread).allowed,
  ).toBe(true);
  expect(decideGateCall({ name: "todo", arguments: { op: "schedule" } }, unread).allowed).toBe(true);
  expect(
    decideGateCall({ name: "write", arguments: { path: "agent://HallwayAudioMesh", content: "rework" } }, [])
      .allowed,
  ).toBe(true);
  expect(
    decideGateCall({ name: "task", arguments: { tasks: [{ name: "HallwayAudioMesh", task: "rework" }] } }, [])
      .allowed,
  ).toBe(true);
});
