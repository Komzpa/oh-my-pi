import { expect, test } from "bun:test";
import { decideGateCall } from "./todo_dispatch";

for (const id of ["todo-link", "todo-replan"]) {
  test(`owner review-link ask remains available under ${id}`, () => {
    const gates = [{ id, remedy: "Repair the plan", satisfies: (call: {name: string}) => call.name === "todo" }];
    const question = { name: "ask", arguments: { questions: [{ id: "camera-end", question: "Choose the camera-end label rule: http://review.invalid:8767/review/camera#camera-end", options: [] }] } };
    expect(decideGateCall(question, gates).allowed).toBe(true);
    expect(decideGateCall({ name: "task", arguments: {} }, gates).allowed).toBe(false);
    expect(decideGateCall({ name: "todo", arguments: {} }, gates).allowed).toBe(true);
    expect(decideGateCall({ name: "read", arguments: {} }, gates).allowed).toBe(true);
  });
}
