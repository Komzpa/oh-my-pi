import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type SessionContextEntryMetadata, sessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { dispatchStateEntries, todoStateEntries } from "./todo_dispatch";

test("live plan checks do not read historical TODO payloads and observe later changes", () => {
  let phases = [{ name: "Current", tasks: [{ content: "Continue worker", status: "in_progress" }] }];
  let todoReads = 0;
  const user = { id: "user", parentId: null, timestamp: "2026-10-18T00:00:00Z", type: "message" as const, message: { role: "user" as const, content: "continue", timestamp: 0 } };
  const metadata: SessionContextEntryMetadata = { type: "custom", customType: "user_todo_edit" };
  const ctx = {
    getTodoPhases: () => structuredClone(phases),
    sessionManager: {
      getBranch: () => { throw new Error("full journal read"); },
      getBranchMatching: (predicate: (metadata: SessionContextEntryMetadata) => boolean) => {
        for (let i = 0; i < 7000; i++) if (predicate(metadata)) todoReads++;
        return predicate(sessionContextEntryMetadata(user)) ? [user] : [];
      },
    },
  } as unknown as ExtensionContext;
  expect(todoStateEntries(ctx).at(-1)).toMatchObject({ data: { phases } });
  const entries = dispatchStateEntries(ctx);
  expect(entries[0]).toBe(user);
  expect(entries.at(-1)).toMatchObject({ data: { phases } });
  phases = [];
  expect(todoStateEntries(ctx).at(-1)).toMatchObject({ data: { phases: [] } });
  expect(dispatchStateEntries(ctx).at(-1)).toMatchObject({ data: { phases: [] } });
  expect(todoReads).toBe(0);
});

test("pending edits keep full durable replay history and their original order", () => {
  const history = [{ id: "archive", parentId: null, timestamp: "2026-10-18T00:00:00Z", type: "custom" as const, customType: "user_todo_edit", data: { edit: { kind: "archive" } } }];
  const pending = [{ type: "custom", customType: "user_todo_edit", data: { phases: [] } }];
  const ctx = {
    getTodoPhases: () => { throw new Error("pending edits require durable replay"); },
    sessionManager: {
      getBranch: () => history,
      getBranchMatching: (predicate: (metadata: SessionContextEntryMetadata) => boolean) => history.filter(entry => predicate(sessionContextEntryMetadata(entry))),
    },
  } as unknown as ExtensionContext;
  expect(todoStateEntries(ctx, pending)).toEqual([...history, ...pending]);
  expect(dispatchStateEntries(ctx, pending)).toEqual([...history, ...pending]);
});
