// B1 regression: push REAL spans through the real @sentry/nextjs 11 SDK (default traceLifecycle
// 'stream', which ignores beforeSendTransaction) with our production options, capture the outgoing
// envelopes with a fake transport, and assert nothing sensitive leaves.
import assert from "node:assert/strict";
import test from "node:test";
import * as Sentry from "@sentry/nextjs";
import { installPrivacyHooks, sentryOptions } from "../lib/sentry/options";

const LEAKS = [
  "bob@ex.com",
  "bob%40ex.com",
  "jane.doe@example.com",
  "OAUTHCODE",
  "STATEVAL",
  "hunter2",
  "sk-or-v1-ABCDEFGHIJKLMNOPQRST",
  "sk_0123456789abcdef0123456789abcdef",
  "abc123secret",
];

test("streamed spans are scrubbed by beforeSendSpan (real SDK, fake transport)", async () => {
  const envelopes: string[] = [];
  Sentry.init({
    ...sentryOptions("https://publickey@o0.ingest.sentry.io/0", "1", "test"),
    transport: () => ({
      send: async (envelope: unknown) => {
        envelopes.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
  installPrivacyHooks(Sentry.getClient());
  assert.equal(Sentry.getClient()?.getOptions().traceLifecycle, "stream");

  const query = "?email=bob%40ex.com&page=2&code=OAUTHCODE&state=STATEVAL";
  Sentry.startSpan(
    {
      name: `GET /api/qa-boom${query}`,
      op: "http.server",
      attributes: {
        "http.target": `/api/qa-boom${query}`,
        "http.url": `https://emori.example/api/qa-boom${query}`,
        "url.full": `https://emori.example/api/qa-boom?email=bob@ex.com&code=OAUTHCODE`,
        "url.query": "email=bob%40ex.com&code=OAUTHCODE&token=abc123secret",
        "url.path": "/reset-password/abc123secret",
        "http.route": "/api/qa-boom",
        "nextjs.request_path": `/api/qa-boom${query}`,
        "http.request.header.authorization": ["Bearer sk-or-v1-ABCDEFGHIJKLMNOPQRST"],
        "custom.note": "for jane.doe@example.com key sk_0123456789abcdef0123456789abcdef",
      },
    },
    () => {
      Sentry.startSpan({ name: "executing api route (app) /api/qa-boom" }, (child) => {
        child.setStatus({
          code: 2,
          message: "Boom jane.doe@example.com Bearer sk-or-v1-ABCDEFGHIJKLMNOPQRST password=hunter2",
        });
      });
    },
  );
  await Sentry.getClient()?.flush(2000);

  const all = envelopes.join("\n");
  assert.match(all, /"type":"span"/, "expected streamed span envelopes");
  for (const leak of LEAKS) assert.ok(!all.includes(leak), `leaked ${leak}`);
  // Useful debugging data survives.
  assert.ok(all.includes("page=2"));
  assert.ok(all.includes("/api/qa-boom"));
  assert.ok(all.includes("[Filtered]"));
  assert.ok(all.includes("[email]"));
});
