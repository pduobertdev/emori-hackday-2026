// Negative control for tests/sentry-dsc-sdk.test.ts: proves the DSC path is real and is covered
// only by the createDsc hook (beforeSend / beforeSendSpan alone don't reach it).
import assert from "node:assert/strict";
import test from "node:test";
import { captureWithCustomRootName } from "./helpers/sentry-dsc";

test("negative control: without installPrivacyHooks the DSC carries the raw root span name", async () => {
  const { all, baggage } = await captureWithCustomRootName(false);
  assert.match(all, /"type":"event"/);
  assert.ok(all.includes("OAUTHCODE") && baggage.includes("OAUTHCODE"), "expected the unhooked DSC to leak");
});
