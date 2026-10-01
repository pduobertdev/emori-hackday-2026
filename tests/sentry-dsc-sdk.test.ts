// (b) The DSC (envelope `trace` header + outgoing `baggage`) carries the raw root span name and is
// covered ONLY by the createDsc hook. Next.js names root spans by route, so this is defense in depth;
// span (beforeSendSpan) and event (beforeSend) scrubbing remain the primary protection.
import assert from "node:assert/strict";
import test from "node:test";
import { captureWithCustomRootName } from "./helpers/sentry-dsc";

test("createDsc hook scrubs the envelope trace header and outgoing baggage (real SDK)", async () => {
  const { all, baggage } = await captureWithCustomRootName(true);
  assert.match(all, /"type":"event"/);
  assert.match(all, /"trace":\{[^}]*"transaction":"GET \/cb\?code=\[Filtered\]&email=\[Filtered\]&page=2"/);
  assert.match(baggage, /sentry-transaction=/);
  assert.ok(!decodeURIComponent(baggage).includes("OAUTHCODE"), `baggage leaked: ${baggage}`);
  for (const leak of ["OAUTHCODE", "bob@ex.com", "bob%40ex.com"]) assert.ok(!all.includes(leak), `leaked ${leak}`);
});
