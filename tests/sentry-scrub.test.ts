import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "@sentry/nextjs";
import { sentryOptions, tracesSampleRate } from "../lib/sentry/options";
import {
  EMAIL_PLACEHOLDER,
  FILTERED,
  isSensitivePath,
  scrubBreadcrumb,
  scrubEvent,
  scrubString,
  scrubUrl,
} from "../lib/sentry/scrub";

test("emails are redacted from messages and exception values", () => {
  const event = scrubEvent({
    message: "Failed to notify jane.doe+promo@example.co.uk",
    exception: { values: [{ type: "Error", value: "User BOB@Emori.co not found" }] },
  } as Event);
  assert.equal(event.message, `Failed to notify ${EMAIL_PLACEHOLDER}`);
  assert.equal(event.exception?.values?.[0].value, `User ${EMAIL_PLACEHOLDER} not found`);
});

test("sensitive keys are filtered recursively, harmless values kept", () => {
  const event = scrubEvent({
    extra: {
      email: "a@b.co",
      email_hash: "abc",
      emailHash: "abc",
      access_token: "t",
      password: "p",
      apiKey: "k",
      nested: { deeper: [{ refresh_token: "r", note: "mail x@y.io", n: 3 }] },
      harmless: "keep me",
    },
  } as Event);
  const extra = event.extra as Record<string, unknown>;
  for (const k of ["email", "email_hash", "emailHash", "access_token", "password", "apiKey"]) {
    assert.equal(extra[k], FILTERED, k);
  }
  assert.deepEqual(extra.nested, { deeper: [{ refresh_token: FILTERED, note: `mail ${EMAIL_PLACEHOLDER}`, n: 3 }] });
  assert.equal(extra.harmless, "keep me");
});

test("cookies are dropped and auth headers filtered", () => {
  const event = scrubEvent({
    request: {
      url: "https://emori.example/",
      cookies: { session: "s" },
      headers: {
        authorization: "Bearer abc",
        Cookie: "session=s",
        "x-csrf-token": "c",
        "stripe-signature": "t=1,v1=x",
        "x-api-key": "k",
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
        "cf-connecting-ip": "203.0.113.9",
        forwarded: "for=203.0.113.9",
        "user-agent": "Mozilla/5.0",
      },
      env: { REMOTE_ADDR: "203.0.113.9" },
    },
  } as Event);
  assert.equal(event.request?.env, undefined);
  assert.equal(event.request?.cookies, undefined);
  const h = event.request?.headers as Record<string, string>;
  for (const k of ["authorization", "Cookie", "x-csrf-token", "stripe-signature", "x-api-key", "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded"]) {
    assert.equal(h[k], FILTERED, k);
  }
  assert.equal(h["user-agent"], "Mozilla/5.0");
});

const sensitive = [
  "/login",
  "/api/auth/login",
  "/register",
  "/api/auth/register-pending/verify",
  "/forgot-password",
  "/api/profile/password",
  "/api/auth/oauth-exchange",
  "/sanctum/csrf-cookie",
  "/api/auth/web-token",
  "/stripe/webhook",
  "/webhooks/x",
  "/checkout",
  "/api/subscription/cancel",
  "/api/memory/entries",
  "/api/chat",
  "/api/voice/transcribe",
];

for (const path of sensitive) {
  test(`request body dropped on ${path}`, () => {
    assert.ok(isSensitivePath(path));
    const event = scrubEvent({
      request: { url: `https://emori.example${path}?q=hello`, query_string: "q=hello", data: { text: "hello" } },
    } as Event);
    assert.equal(event.request?.data, undefined);
    assert.equal(event.request?.query_string, undefined);
    assert.equal(event.request?.url, `https://emori.example${path}`);
  });
}

test("request body dropped on ordinary routes too", () => {
  assert.equal(isSensitivePath("/api/author-settings"), false);
  for (const data of [{ title: "with sam@example.com", email: "sam@example.com", n: 1 }, '{"memory":"private"}']) {
    const event = scrubEvent({
      request: { url: "https://emori.example/api/other?page=2", method: "POST", data },
    } as Event);
    assert.equal(event.request?.data, undefined);
    assert.equal(event.request?.method, "POST");
    assert.equal(event.request?.url, "https://emori.example/api/other?page=2");
  }
});

test("URL tokens and query params are scrubbed", () => {
  assert.equal(
    scrubUrl("https://x.io/reset-password/abc123?email=jane%40x.io&token=t&code=c&page=2"),
    `https://x.io/reset-password/${FILTERED}?email=${FILTERED}&token=${FILTERED}&code=${FILTERED}&page=2`,
  );
  assert.equal(scrubUrl("/reset-password/{token}"), "/reset-password/{token}");
  const event = scrubEvent({ request: { url: "https://x.io/a", query_string: "state=s&q=jane@x.io" } } as Event);
  assert.equal(event.request?.query_string, `state=${FILTERED}&q=${EMAIL_PLACEHOLDER}`);
});

test("free-text credentials are redacted", () => {
  assert.equal(scrubString("Bearer abc.def-ghi sent"), `Bearer ${FILTERED} sent`);
  assert.equal(scrubString("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"), `jwt ${FILTERED}`);
  assert.equal(scrubString("key sk-or-v1-0123456789abcdef0123"), `key ${FILTERED}`);
  assert.equal(scrubString("stripe sk_live_51Habc and whsec_abc"), `stripe ${FILTERED} and ${FILTERED}`);
  assert.equal(scrubString("failed token=abc123 for user"), `failed token=${FILTERED} for user`);
  assert.equal(scrubString("email_hash: 5d41402a"), `email_hash: ${FILTERED}`);
  assert.equal(scrubString("Order 1234 shipped"), "Order 1234 shipped");
});

test("user keeps only id; breadcrumbs, tags, contexts, spans and frame vars scrubbed", () => {
  const event = scrubEvent({
    type: "transaction",
    user: { id: "7", email: "j@x.io", ip_address: "203.0.113.9", username: "j" },
    tags: { customer_email: "a@b.co", plan: "pro" },
    contexts: { job: { payload: { email: "a@b.co", id: 5 } } },
    breadcrumbs: [{ message: "sent to j@x.io", data: { token: "t", url: "https://api.x.io/v1?api_key=k&q=1" } }],
    exception: { values: [{ value: "x", stacktrace: { frames: [{ vars: { password: "p", n: 1 } }] } }] },
    spans: [{ description: "GET https://api.x.io/u?email=j@x.io", data: { authorization: "Bearer x" } }],
  } as unknown as Event);
  assert.deepEqual(event.user, { id: "7" });
  assert.deepEqual(event.tags, { customer_email: FILTERED, plan: "pro" });
  assert.deepEqual((event.contexts as Record<string, unknown>).job, { payload: { email: FILTERED, id: 5 } });
  assert.equal(event.breadcrumbs?.[0].message, `sent to ${EMAIL_PLACEHOLDER}`);
  assert.deepEqual(event.breadcrumbs?.[0].data, { token: FILTERED, url: `https://api.x.io/v1?api_key=${FILTERED}&q=1` });
  assert.deepEqual(event.exception?.values?.[0].stacktrace?.frames?.[0].vars, { password: FILTERED, n: 1 });
  assert.equal(event.spans?.[0].description, `GET https://api.x.io/u?email=${FILTERED}`);
  assert.deepEqual(event.spans?.[0].data, { authorization: FILTERED });
});

test("code/state are filtered as query params but kept as object keys; logentry scrubbed", () => {
  const event = scrubEvent({
    extra: { code: "ECONNREFUSED", state: "open" },
    logentry: { message: "login for %s by a@b.co", params: ["j@x.io", { token: "t" }] },
  } as Event);
  assert.deepEqual(event.extra, { code: "ECONNREFUSED", state: "open" });
  assert.equal(event.logentry?.message, `login for %s by ${EMAIL_PLACEHOLDER}`);
  assert.deepEqual(event.logentry?.params, [EMAIL_PLACEHOLDER, { token: FILTERED }]);
});

test("environment comes from the caller, falling back to NODE_ENV", () => {
  assert.equal(sentryOptions("https://public@o0.ingest.sentry.io/0", undefined, "preview").environment, "preview");
  assert.equal(sentryOptions("https://public@o0.ingest.sentry.io/0", undefined, undefined).environment, process.env.NODE_ENV);
  const deny = (sentryOptions("x", undefined).dataCollection.httpHeaders.request as { deny: string[] }).deny;
  for (const h of ["authorization", "cookie", "x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip"]) assert.ok(deny.includes(h), h);
});

test("standalone breadcrumb scrubbing", () => {
  assert.equal(scrubBreadcrumb({ message: "login a@b.co" }).message, `login ${EMAIL_PLACEHOLDER}`);
});

test("options: disabled without DSN, privacy-first, low trace rate", () => {
  for (const dsn of [undefined, "", "  "]) {
    const o = sentryOptions(dsn, undefined);
    assert.equal(o.enabled, false);
    assert.equal(o.dsn, undefined);
  }
  const o = sentryOptions("https://public@o0.ingest.sentry.io/0", undefined);
  assert.equal(o.enabled, true);
  assert.equal(o.tracesSampleRate, 0.05);
  assert.equal(o.dataCollection.userInfo, false);
  assert.equal(o.dataCollection.cookies, false);
  assert.deepEqual(o.dataCollection.httpBodies, []);
  assert.deepEqual(o.dataCollection.genAI, { inputs: false, outputs: false });
  assert.equal("profilesSampleRate" in o, false);
  assert.equal(tracesSampleRate(""), 0.05);
  assert.equal(tracesSampleRate("0.2"), 0.2);
  assert.equal(tracesSampleRate("abc"), 0.05);
  assert.equal(tracesSampleRate("5"), 0.05);
});
