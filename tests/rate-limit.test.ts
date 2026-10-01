import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  InMemoryRateLimitStore,
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

test("clientIp uses only platform headers; x-forwarded-for is ignored entirely", () => {
  const h = (headers: Record<string, string>) => ({ headers: new Headers(headers) });
  assert.equal(clientIp(h({ "x-vercel-forwarded-for": "11.11.11.11" })), "11.11.11.11");
  assert.equal(clientIp(h({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
  // x-forwarded-for is client-controllable off-Vercel, so it is never trusted — not even the last hop.
  assert.equal(clientIp(h({ "x-forwarded-for": "6.6.6.6, 2.2.2.2" })), "unknown");
  assert.equal(clientIp(h({})), "unknown");
  // Platform header wins over XFF even when both are present.
  assert.equal(clientIp(h({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "6.6.6.6, 2.2.2.2" })), "9.9.9.9");
});

test("a spoofed x-forwarded-for cannot mint a fresh rate-limit bucket", () => {
  const rule = { limit: 1, windowSeconds: 60 };
  const now = 4_000_000;
  // Attacker rotates x-forwarded-for; with no trusted header it collapses to one "unknown" bucket.
  const req = (forged: string) => ({ headers: new Headers({ "x-forwarded-for": forged }) });
  assert.equal(checkRateLimit(`demo-mint:${clientIp(req("a.a.a.a"))}`, rule, now).ok, true);
  assert.equal(
    checkRateLimit(`demo-mint:${clientIp(req("b.b.b.b, c.c.c.c"))}`, rule, now).ok,
    false,
    "any spoofed XFF maps to the same 'unknown' bucket and is blocked",
  );
});

test("a full partition evicts the least-recently-used key, never fails closed", () => {
  const store = new InMemoryRateLimitStore(2); // cap 2 buckets per partition
  const rule = { limit: 2, windowSeconds: 60 };
  const now = 5_000_000;

  assert.equal(store.hit("x:ip:a", rule, now).ok, true); // a=1
  assert.equal(store.hit("x:ip:b", rule, now).ok, true); // b=1, partition full
  assert.equal(store.hit("x:ip:a", rule, now).ok, true); // a=2 → a most-recent, b is now LRU
  assert.equal(store.hit("x:ip:c", rule, now).ok, true); // new key admitted → evicts LRU (b)

  assert.equal(store.hit("x:ip:a", rule, now).ok, false, "a was recently used, so it is preserved and still at its limit");
  assert.equal(store.hit("x:ip:b", rule, now).ok, true, "b was the LRU, so it was evicted and its counter reset");
});

test("a flood of distinct IPs can never evict or lock out a per-user bucket", () => {
  const store = new InMemoryRateLimitStore(100);
  const rule = { limit: 1, windowSeconds: 60 };
  const now = 6_000_000;

  assert.equal(store.hit("chat:user:alice", rule, now).ok, true); // alice at her limit

  // Flood the IP partition far beyond its capacity — only the IP partition evicts.
  for (let i = 0; i < 1_000; i++) store.hit(`chat:ip:${i}`, rule, now);

  assert.equal(store.hit("chat:user:alice", rule, now).ok, false, "alice's user bucket survived the IP flood");
  assert.equal(store.hit("chat:user:bob", rule, now).ok, true, "a fresh user is not locked out by the IP flood");
});

test("demo-mint keys live in their own partition, separate from per-IP buckets", () => {
  const store = new InMemoryRateLimitStore(1); // one bucket per partition
  const rule = { limit: 1, windowSeconds: 60 };
  const now = 7_000_000;

  assert.equal(store.hit("demo-mint:1.2.3.4", rule, now).ok, true);
  // A per-IP key for a different class does not evict the lone demo-mint bucket (different partition).
  assert.equal(store.hit("chat:ip:1.2.3.4", rule, now).ok, true);
  assert.equal(store.hit("demo-mint:1.2.3.4", rule, now).ok, false, "the demo-mint bucket is intact");
});

test("env overrides the default rule when well-formed, and is ignored when not", () => {
  const original = RATE_LIMITS.chat();
  assert.deepEqual(original, { limit: 30, windowSeconds: 60 });

  process.env.RATE_LIMIT_CHAT = "5:10";
  assert.deepEqual(RATE_LIMITS.chat(), { limit: 5, windowSeconds: 10 });

  process.env.RATE_LIMIT_CHAT = "garbage";
  assert.deepEqual(RATE_LIMITS.chat(), { limit: 30, windowSeconds: 60 }, "malformed env falls back to the default");
});
