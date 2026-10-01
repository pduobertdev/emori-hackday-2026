import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  RATE_LIMITS,
  __resetRateLimitsForTests,
  checkRateLimit,
  clientIp,
} from "../lib/auth/rate-limit";

afterEach(() => {
  __resetRateLimitsForTests();
  delete process.env.RATE_LIMIT_CHAT;
});

test("allows up to the limit, then blocks with a positive Retry-After", () => {
  const rule = { limit: 3, windowSeconds: 60 };
  const now = 1_000_000;

  assert.equal(checkRateLimit("k", rule, now).ok, true);
  assert.equal(checkRateLimit("k", rule, now).ok, true);
  assert.equal(checkRateLimit("k", rule, now).ok, true);

  const blocked = checkRateLimit("k", rule, now);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
});

test("the window resets after it elapses", () => {
  const rule = { limit: 1, windowSeconds: 60 };
  const start = 2_000_000;

  assert.equal(checkRateLimit("w", rule, start).ok, true);
  assert.equal(checkRateLimit("w", rule, start + 1_000).ok, false);
  assert.equal(checkRateLimit("w", rule, start + 61_000).ok, true, "a fresh window allows again");
});

test("keys are independent", () => {
  const rule = { limit: 1, windowSeconds: 60 };
  const now = 3_000_000;
  assert.equal(checkRateLimit("a", rule, now).ok, true);
  assert.equal(checkRateLimit("b", rule, now).ok, true, "a different key has its own budget");
  assert.equal(checkRateLimit("a", rule, now).ok, false);
});

test("clientIp uses platform headers and the LAST x-forwarded-for hop, never the spoofable first", () => {
  const h = (headers: Record<string, string>) => ({ headers: new Headers(headers) });
  assert.equal(clientIp(h({ "x-vercel-forwarded-for": "11.11.11.11" })), "11.11.11.11");
  assert.equal(clientIp(h({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
  // The proxy appends the real IP, so the last hop is the trustworthy one.
  assert.equal(clientIp(h({ "x-forwarded-for": "6.6.6.6, 2.2.2.2" })), "2.2.2.2");
  assert.equal(clientIp(h({})), "unknown");
  // Platform header wins over raw XFF even when both are present.
  assert.equal(clientIp(h({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "6.6.6.6, 2.2.2.2" })), "9.9.9.9");
});

test("a spoofed first x-forwarded-for hop cannot mint a fresh rate-limit bucket", () => {
  const rule = { limit: 1, windowSeconds: 60 };
  const now = 4_000_000;
  // Same real (last) hop, attacker rotates only the first hop.
  const req = (forgedFirst: string) => ({ headers: new Headers({ "x-forwarded-for": `${forgedFirst}, 2.2.2.2` }) });
  assert.equal(checkRateLimit(`demo-mint:${clientIp(req("a.a.a.a"))}`, rule, now).ok, true);
  assert.equal(
    checkRateLimit(`demo-mint:${clientIp(req("b.b.b.b"))}`, rule, now).ok,
    false,
    "rotating the forged first hop maps to the same bucket and is blocked",
  );
});

test("caps the bucket Map and fails closed for brand-new keys when it is full of live buckets", () => {
  const rule = { limit: 5, windowSeconds: 60 };
  const now = 5_000_000;
  for (let i = 0; i < 10_000; i++) {
    assert.equal(checkRateLimit(`cap-${i}`, rule, now).ok, true);
  }
  const overflow = checkRateLimit("cap-overflow", rule, now);
  assert.equal(overflow.ok, false, "a new key is rejected while the Map is full");
  if (!overflow.ok) assert.equal(overflow.retryAfterSeconds, rule.windowSeconds);
  // An already-tracked key still counts (it does not grow the Map).
  assert.equal(checkRateLimit("cap-0", rule, now).ok, true);
  // Once live buckets expire, a new key is admitted again.
  assert.equal(checkRateLimit("cap-overflow", rule, now + 61_000).ok, true);
});

test("env overrides the default rule when well-formed, and is ignored when not", () => {
  const original = RATE_LIMITS.chat();
  assert.deepEqual(original, { limit: 30, windowSeconds: 60 });

  process.env.RATE_LIMIT_CHAT = "5:10";
  assert.deepEqual(RATE_LIMITS.chat(), { limit: 5, windowSeconds: 10 });

  process.env.RATE_LIMIT_CHAT = "garbage";
  assert.deepEqual(RATE_LIMITS.chat(), { limit: 30, windowSeconds: 60 }, "malformed env falls back to the default");
});
