import { expect, test } from "bun:test";
import { branchAsyncTaskResults, branchRetroReceiptIds } from "./todo_dispatch";

const result = (id: string, output: unknown) => `<task-result id="${id}" agent="retro-facilitator" status="completed"><output>${JSON.stringify(output)}</output></task-result>`;
function context(entries: any[]) {
  const hydrated: number[] = [];
  const ctx = { sessionManager: {
    getBranch: () => { throw new Error("full journal hydration"); },
    getBranchMatching: (predicate: (metadata: any) => boolean) => entries.flatMap((entry, index) => {
      const metadata = {type: entry.type, customType: entry.customType, messageRole: entry.message?.role};
      if (!predicate(metadata)) return [];
      hydrated.push(index);
      return [entry];
    }),
  }};
  return { ctx: ctx as never, hydrated };
}
test("receipt scans share the last 500 branch-entry window before hydrating payloads", () => {
  const outside = {type: "custom_message", content: result("UpdaterOutside", { accepted: true })};
  const inside = {type: "message", message: {role: "user", content: [{type: "text", text: result("UpdaterInside", { accepted: false })}]}};
  const last = {type: "custom_message", content: result("UpdaterLast", { accepted: true })};
  // 503 entries: index 2 excluded, index 3 included; metadata entries consume window positions.
  const entries = [outside, outside, outside, inside, ...Array.from({length: 498}, () => ({type:"custom",customType:"irrelevant",data:{large:"not read"}})), last];
  const {ctx, hydrated} = context(entries);
  expect(branchAsyncTaskResults(ctx).map((job: any) => [job.id, job.result])).toEqual([
    ["UpdaterInside", {accepted:false}], ["UpdaterLast", {accepted:true}],
  ]);
  expect(hydrated).toEqual([3, 502]);
  hydrated.length = 0;
  expect(branchRetroReceiptIds(ctx)).toEqual(["UpdaterInside", "UpdaterLast"]);
  expect(hydrated).toEqual([3, 502]);
});
test("incomplete and malformed worker output stays excluded", () => {
  const {ctx} = context([
    {type:"custom_message",content:'<task-result id="UpdaterBad" status="completed"><output>not JSON</output></task-result>'},
    {type:"custom_message",content:'<task-result id="UpdaterRunning" status="running"><output>{}</output></task-result>'},
    {type:"custom_message",content:result("OtherWorker", {})},
  ]);
  expect(branchAsyncTaskResults(ctx)).toEqual([]);
});
