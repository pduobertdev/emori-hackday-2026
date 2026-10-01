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
  MAX_SCRUB_LENGTH,
  TRUNCATED_MARKER,
  safeBeforeBreadcrumb,
  safeBeforeSend,
  scrubDsc,
  scrubQueryString,
  scrubStreamedSpan,
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

test("B2: request paths/URLs in contexts go through scrubUrl (raw query)", () => {
  const event = scrubEvent({
    contexts: {
      nextjs: { request_path: "/api/qa-boom?email=bob%40ex.com&page=2&code=OAUTHCODE", route_type: "route" },
      other: { url: "https://x.io/cb?state=S1&code=C1&q=ok", href: "/p?token=t1" },
    },
  } as unknown as Event);
  const ctx = event.contexts as Record<string, Record<string, string>>;
  assert.equal(ctx.nextjs.request_path, `/api/qa-boom?email=${FILTERED}&page=2&code=${FILTERED}`);
  assert.equal(ctx.nextjs.route_type, "route");
  assert.equal(ctx.other.url, `https://x.io/cb?state=${FILTERED}&code=${FILTERED}&q=ok`);
  assert.equal(ctx.other.href, `/p?token=${FILTERED}`);
});

test("B2: scrubString/scrubUrl percent-decode first (encoded emails, malformed input safe)", () => {
  assert.equal(scrubString("user bob%40ex.com failed"), `user ${EMAIL_PLACEHOLDER} failed`);
  // Double-encoded (%2540) is decoded too.
  assert.equal(scrubString("double bob%2540ex.com"), `double ${EMAIL_PLACEHOLDER}`);
  assert.equal(scrubUrl("/x?u=bob%40ex.com&n=1"), `/x?u=${EMAIL_PLACEHOLDER}&n=1`);
  // Malformed encodings never throw; valid runs next to them still decode.
  assert.doesNotThrow(() => scrubString("bad %E0%A4%A and %ZZ and %"));
  assert.equal(scrubString("bad %E0%A4%A then bob%40ex.com"), `bad %E0%A4%A then ${EMAIL_PLACEHOLDER}`);
  assert.equal(scrubUrl("/x?%E0%A4%A=1&email=bob%40ex.com"), `/x?%E0%A4%A=1&email=${FILTERED}`);
});

test("B2: code=/state=/token=/email= are filtered in raw query strings inside free text", () => {
  assert.equal(
    scrubString("GET /cb?code=OAUTHCODE&state=S&page=2&token=T&email=bob%40ex.com"),
    `GET /cb?code=${FILTERED}&state=${FILTERED}&page=2&token=${FILTERED}&email=${FILTERED}`,
  );
  // Non-query "code" in prose stays readable.
  assert.equal(scrubString("error code: ECONNREFUSED"), "error code: ECONNREFUSED");
});

test("ElevenLabs sk_ and OpenRouter sk-or-v1- keys are redacted", () => {
  assert.equal(scrubString("key sk_0123456789abcdef0123456789abcdef end"), `key ${FILTERED} end`);
  assert.equal(scrubString("or sk-or-v1-0123456789abcdefABCDEF end"), `or ${FILTERED} end`);
  // Short sk_ identifiers (not keys) are left alone.
  assert.equal(scrubString("sk_short"), "sk_short");
});

test("B1: scrubStreamedSpan scrubs name, string attributes, typed attributes and arrays", () => {
  const span = scrubStreamedSpan({
    trace_id: "t",
    span_id: "s",
    name: "GET /?email=bob@ex.com&code=OAUTHCODE",
    start_timestamp: 1,
    status: "error",
    is_segment: true,
    attributes: {
      "http.target": "/?email=bob@ex.com&code=OAUTHCODE&page=2",
      "url.query": "?token=abc&code=C&page=2",
      "sentry.status.message": "Boom jane@x.io Bearer sk-or-v1-ABCDEFGHIJKLMNOPQRST password=hunter2",
      "http.request.header.cookie": ["a=b"],
      "typed.message": { value: "mail jane@x.io", type: "string" },
      "http.status_code": 500,
      "http.route": "/api/qa-boom",
    },
    links: [{ context: { traceId: "t", spanId: "s" }, attributes: { "url.full": "https://x.io/?email=a@b.co" } }],
  } as unknown as Parameters<typeof scrubStreamedSpan>[0]);
  assert.equal(span.name, `GET /?email=${FILTERED}&code=${FILTERED}`);
  const a = span.attributes as Record<string, unknown>;
  assert.equal(a["http.target"], `/?email=${FILTERED}&code=${FILTERED}&page=2`);
  assert.equal(a["url.query"], `token=${FILTERED}&code=${FILTERED}&page=2`);
  assert.equal(a["sentry.status.message"], `Boom ${EMAIL_PLACEHOLDER} Bearer ${FILTERED} password=${FILTERED}`);
  assert.deepEqual(a["http.request.header.cookie"], [FILTERED]);
  assert.deepEqual(a["typed.message"], { value: `mail ${EMAIL_PLACEHOLDER}`, type: "string" });
  assert.equal(a["http.status_code"], 500);
  assert.equal(a["http.route"], "/api/qa-boom");
  assert.equal((span.links?.[0].attributes as Record<string, unknown>)["url.full"], `https://x.io/?email=${FILTERED}`);
});

test("options: streaming kept with beforeSendSpan wired", () => {
  const o = sentryOptions("x", undefined);
  assert.equal(o.traceLifecycle, "stream");
  assert.equal(typeof o.beforeSendSpan, "function");
});

// ---- Security round 2 ----

const gen = (chars: string, n: number) => {
  let out = "";
  for (let i = 0; i < n; i++) out += chars[(i * 7) % chars.length];
  return out;
};
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

test("ReDoS: 100K-char adversarial strings scrub in well under 50ms", () => {
  const N = 100_000;
  const inputs: Record<string, string> = {
    alnum: gen(ALNUM, N),
    "alnum+@": gen(ALNUM, N / 2) + "@" + gen(ALNUM, N / 2),
    "alnum@end": gen(ALNUM, N) + "@",
    base64: gen(B64, N),
    "base64+@": gen(B64, N / 2) + "@" + gen(B64, N / 2),
    "many-@": "a@b".repeat(N / 3),
    "label-dots": "a@" + "a.".repeat(N / 2),
    dashes: "a-".repeat(N / 2),
    "eyJ-run": "eyJ-".repeat(N / 4),
    "sk-run": "sk-".repeat(N / 3),
    "token-run": "token_".repeat(N / 6),
    "bad-pct": "%FF%40".repeat(N / 6),
  };
  for (const [name, input] of Object.entries(inputs)) {
    for (const fn of [scrubString, scrubUrl, scrubQueryString]) {
      fn(input); // warm-up (JIT)
      const t = performance.now();
      const out = fn(input);
      const ms = performance.now() - t;
      assert.ok(ms < 50, `${fn.name}(${name}) took ${ms.toFixed(1)}ms`);
      // (+ room for a trailing "=[Filtered]" when the whole input is one sensitive query key)
      assert.ok(out.length <= MAX_SCRUB_LENGTH + 16, `${fn.name}(${name}) not truncated`);
    }
  }
});

test("strings over 8KB are truncated with a marker before any regex runs", () => {
  const long = "x".repeat(20_000);
  const out = scrubString(long);
  assert.ok(out.endsWith(TRUNCATED_MARKER));
  assert.ok(out.length <= MAX_SCRUB_LENGTH);
  assert.equal(scrubString("short"), "short");
  // An email cut in half at the boundary is dropped, not leaked partially.
  const cut = "y ".repeat((MAX_SCRUB_LENGTH - TRUNCATED_MARKER.length - 10) / 2) + "jane.doe@example.com" + "z".repeat(10_000);
  const cutOut = scrubString(cut);
  assert.ok(!cutOut.includes("jane"), "partial email leaked at truncation boundary");
  assert.ok(cutOut.endsWith(TRUNCATED_MARKER));
  // Emails before the cut are still scrubbed.
  assert.ok(scrubString("mail jane@x.io " + "q".repeat(20_000)).startsWith(`mail ${EMAIL_PLACEHOLDER} `));
});

test("sensitive query keys are themselves scrubbed (no raw key leak)", () => {
  assert.equal(scrubQueryString("my_token_jane@x.io=abc&n=1"), `${EMAIL_PLACEHOLDER}=${FILTERED}&n=1`);
});

test("(a) one invalid %XX in a run no longer hides an encoded @", () => {
  assert.equal(scrubString("user bob%FF%40example.com"), `user ${EMAIL_PLACEHOLDER}`);
  assert.equal(scrubUrl("/x?u=bob%FF%40example.com&n=1"), `/x?u=${EMAIL_PLACEHOLDER}&n=1`);
  // Non-ASCII invalid bytes stay encoded; valid multi-byte UTF-8 still decodes.
  assert.equal(scrubString("caf%C3%A9 %FF"), "café %FF");
});

test("fail closed: scrubStreamedSpan strips the span if scrubbing throws", () => {
  const span = {
    trace_id: "t",
    span_id: "s",
    name: "GET /?email=bob@ex.com",
    start_timestamp: 1,
    status: "error",
    is_segment: true,
    attributes: {},
  } as unknown as Parameters<typeof scrubStreamedSpan>[0];
  Object.defineProperty(span, "attributes", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("boom");
    },
    set(v) {
      Object.defineProperty(span, "attributes", { value: v, writable: true, enumerable: true, configurable: true });
    },
  });
  const out = scrubStreamedSpan(span);
  assert.equal(out.name, FILTERED);
  assert.deepEqual(out.attributes, {});
  assert.ok(!JSON.stringify(out).includes("bob@ex.com"));
});

test("fail closed: beforeSend drops the event (null) and beforeBreadcrumb drops the crumb if scrubbing throws", () => {
  const hostile = {
    message: "for jane@x.io",
    get request(): never {
      throw new Error("boom");
    },
  } as unknown as Event;
  assert.equal(safeBeforeSend(hostile), null);
  assert.equal(safeBeforeSend({ message: "for jane@x.io" } as Event)?.message, `for ${EMAIL_PLACEHOLDER}`);
  const crumb = {
    get message(): never {
      throw new Error("boom");
    },
  };
  assert.equal(safeBeforeBreadcrumb(crumb as never), null);
});

test("fail closed: scrubDsc filters the transaction if scrubbing throws", () => {
  const dsc: Record<string, unknown> = { transaction: "GET /cb?code=OAUTHCODE" };
  scrubDsc(dsc);
  assert.equal(dsc.transaction, `GET /cb?code=${FILTERED}`);
  let stored: unknown = "x";
  const hostile: Record<string, unknown> = {};
  let first = true;
  Object.defineProperty(hostile, "transaction", {
    get() {
      if (first) {
        first = false;
        return { toString: () => "never a string" } as unknown; // typeof !== string: untouched
      }
      return stored;
    },
    set(v) {
      stored = v;
    },
  });
  scrubDsc(hostile); // non-string: no-op, no throw
  const throwing: Record<string, unknown> = {};
  Object.defineProperty(throwing, "transaction", {
    get() {
      return "GET /cb?code=OAUTHCODE";
    },
    set(v) {
      if (v !== FILTERED) throw new Error("boom");
      stored = v;
    },
  });
  scrubDsc(throwing);
  assert.equal(stored, FILTERED);
});

test("stack frame source-context lines are scrubbed", () => {
  const event = scrubEvent({
    exception: {
      values: [
        {
          type: "Error",
          value: "x",
          stacktrace: {
            frames: [
              {
                context_line: 'fetch("/cb?code=OAUTHCODE&email=bob%40ex.com")',
                pre_context: ['const key = "sk-or-v1-ABCDEFGHIJKLMNOPQRST";'],
                post_context: ["// owner jane@x.io"],
              },
            ],
          },
        },
      ],
    },
  } as Event);
  const json = JSON.stringify(event);
  for (const leak of ["OAUTHCODE", "bob@ex.com", "sk-or-v1-ABCD", "jane@x.io"]) assert.ok(!json.includes(leak), leak);
});
