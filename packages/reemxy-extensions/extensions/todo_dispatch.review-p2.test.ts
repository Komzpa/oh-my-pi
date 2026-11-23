// @ts-nocheck -- registered-hook regressions for receipt gate review findings.
import { test } from "bun:test";
import { gateReviewFinding } from "./lead-gates.scenarios";

test("only a schedule todo result may reconcile a receipt", async () => {
  await gateReviewFinding("receipt-operation");
});

test("a summarized or elided receipt is not a complete root read", async () => {
  await gateReviewFinding("summary-elision");
});
