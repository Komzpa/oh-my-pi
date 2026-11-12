export async function fixNowScenarios() {
 return [{
  id: "reply-then-wait",
  context: "User: wait for SpawnProbe result, then print it. SpawnProbe is running; no plan is needed.\nHarness (not Darafei): Reply in text to the user before wait/stop. Text alongside the wait tool call is accepted. Then call wait for the running result.",
  expected: { tool: "wait", args: {} },
 }];
}
