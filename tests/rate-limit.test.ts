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

test("clientIp prefers the first x-forwarded-for hop, then x-real-ip, then unknown", () => {
  const h = (headers: Record<string, string>) => ({ headers: new Headers(headers) });
  assert.equal(clientIp(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })), "1.2.3.4");
  assert.equal(clientIp(h({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
  assert.equal(clientIp(h({})), "unknown");
});

test("env overrides the default rule when well-formed, and is ignored when not", () => {
  const original = RATE_LIMITS.chat();
  assert.deepEqual(original, { limit: 30, windowSeconds: 60 });

  process.env.RATE_LIMIT_CHAT = "5:10";
  assert.deepEqual(RATE_LIMITS.chat(), { limit: 5, windowSeconds: 10 });

  process.env.RATE_LIMIT_CHAT = "garbage";
  assert.deepEqual(RATE_LIMITS.chat(), { limit: 30, windowSeconds: 60 }, "malformed env falls back to the default");
});
