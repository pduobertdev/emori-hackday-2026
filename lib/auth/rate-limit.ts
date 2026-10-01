/**
 * A tiny per-key fixed-window rate limiter with no dependencies. Counts hits against a key in an
 * in-memory store; when the window elapses the count resets. This is best-effort and PER INSTANCE:
 * on serverless (Vercel) each warm instance keeps its own counters, so the real cap is roughly the
 * configured limit times the number of live instances.
 *
 * The limiter sits behind a small store interface so a shared store (Vercel KV / Upstash Redis free
 * tier) can plug in later for a global cap without touching the call sites — see the README. The
 * default `InMemoryRateLimitStore` is synchronous; a network-backed store would return a Promise,
 * which the interface allows, and the call sites would then `await checkRateLimit(...)`.
 */

export type RateLimitRule = { limit: number; windowSeconds: number };
export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Pluggable backing store. A future Redis/KV store implements this same `hit`. */
export interface RateLimitStore {
  hit(key: string, rule: RateLimitRule, now: number): RateLimitResult | Promise<RateLimitResult>;
}

type Bucket = { count: number; resetAt: number };

/**
 * Keys live in SEPARATE bounded partitions by class, so no partition can evict another's buckets:
 * - "user": per signed session userId. The real control for every authenticated route.
 * - "ip":   per client IP. Shared by callers behind one NAT; evictable (see below).
 * - "mint":  per IP for demo-session minting (no user exists yet).
 *
 * A flood of spoofed/distinct IPs can only ever fill and evict the "ip" (or "mint") partition; it
 * can never evict or lock out "user" buckets, so an authenticated caller's per-user limit always
 * holds. Keys carry a class prefix (see the key builders at the call sites: `*:user:*`, `*:ip:*`,
 * `demo-mint:*`) and are routed to a partition here.
 */
type Partition = "user" | "ip" | "mint";

function partitionFor(key: string): Partition {
  if (key.startsWith("demo-mint:")) return "mint";
  if (key.includes(":user:")) return "user";
  return "ip";
}

/** Hard ceiling on distinct live keys PER PARTITION, to bound memory. */
const MAX_BUCKETS_PER_PARTITION = 10_000;
const PRUNE_INTERVAL_MS = 60_000;

/** Delete every expired bucket in one partition right now. */
function pruneExpired(map: Map<string, Bucket>, now: number): void {
  for (const [key, bucket] of map) {
    if (bucket.resetAt <= now) map.delete(key);
  }
}

/**
 * In-memory store with per-partition LRU eviction.
 *
 * Each partition is a `Map` whose insertion order we maintain as least-recently-used first: a live
 * hit re-inserts its key to the end, and when a partition is full we evict the first (oldest) key.
 * Evicting an IP/mint bucket RESETS that IP's counter — acceptable, because every authenticated
 * route is also gated by the per-user limit, which lives in its own partition and is never evicted
 * by an IP flood. A user bucket can only be evicted by a flood of distinct signed userIds, which an
 * attacker can only create through the (separately rate-limited) demo-mint path.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly partitions: Record<Partition, Map<string, Bucket>> = {
    user: new Map(),
    ip: new Map(),
    mint: new Map(),
  };
  private lastPrune = 0;

  constructor(private readonly cap: number = MAX_BUCKETS_PER_PARTITION) {}

  hit(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
    this.maybePrune(now);
    const map = this.partitions[partitionFor(key)];

    const existing = map.get(key);
    if (existing && existing.resetAt > now) {
      if (existing.count >= rule.limit) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
      }
      existing.count += 1;
      // Mark most-recently-used: delete + re-set moves the key to the end of the Map's order.
      map.delete(key);
      map.set(key, existing);
      return { ok: true };
    }

    // New or expired key. Drop an expired one so the fresh bucket re-inserts at the end (recent).
    if (existing) map.delete(key);

    // Keep the partition bounded: prune expired, then evict the least-recently-used if still full.
    if (map.size >= this.cap) {
      pruneExpired(map, now);
      if (map.size >= this.cap) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    }

    map.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1000 });
    return { ok: true };
  }

  /** Drop expired buckets across all partitions occasionally so the Maps cannot grow without bound. */
  private maybePrune(now: number): void {
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    for (const map of Object.values(this.partitions)) pruneExpired(map, now);
    this.lastPrune = now;
  }

  reset(): void {
    for (const map of Object.values(this.partitions)) map.clear();
    this.lastPrune = 0;
  }
}

const defaultStore = new InMemoryRateLimitStore();

/**
 * Count one hit against `key`. Synchronous because the default store is in-memory; swap in a shared
 * store (returning a Promise) and `await` this to get a global cap — the signature is unchanged.
 */
export function checkRateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
  return defaultStore.hit(key, rule, now) as RateLimitResult;
}

/**
 * The caller's IP, used only as a rate-limit bucket key.
 *
 * TRUST ASSUMPTION: this app is deployed behind Vercel. Vercel sets `x-vercel-forwarded-for` and
 * `x-real-ip` from the real connecting socket and overwrites any client-supplied copies, so those
 * are trustworthy. (`NextRequest.ip` was removed in this Next version, so we read headers.)
 *
 * We do NOT trust `x-forwarded-for` at all: off-Vercel it is fully client-controlled (a client can
 * send any value, and even the "last hop" is only trustworthy if a known proxy appended it), so
 * reading it would let a caller mint a fresh bucket per request and bypass every per-IP limit.
 *
 * Order: x-vercel-forwarded-for, x-real-ip, else "unknown". Off-Vercel (or when a trusted proxy
 * does not set `x-real-ip`) every caller shares the single "unknown" IP bucket — safe (over-limits,
 * never under-limits). Per-user limits are the real control for authenticated routes.
 */
export function clientIp(request: { headers: { get(name: string): string | null } }): string {
  const vercel = request.headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return vercel;

  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;

  return "unknown";
}

/** Parse a `"limit:windowSeconds"` env override (e.g. "30:60"); fall back to the default if unset or malformed. */
function ruleFromEnv(envKey: string, defaults: RateLimitRule): RateLimitRule {
  const raw = process.env[envKey]?.trim();
  if (!raw) return defaults;

  const [limitRaw, windowRaw] = raw.split(":");
  const limit = Number(limitRaw);
  const windowSeconds = Number(windowRaw);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return defaults;
  }
  return { limit, windowSeconds };
}

/**
 * Named limits, read at call time so tests (and deploys) can override them with env. Keep these
 * modest: the demo is free and the model/voice calls cost real money.
 */
export const RATE_LIMITS = {
  /** Minting an anonymous demo session (proxy auto-issue and POST /api/session/demo share this). */
  demoMint: (): RateLimitRule => ruleFromEnv("RATE_LIMIT_DEMO_MINT", { limit: 10, windowSeconds: 600 }),
  /** Chat completions. Applied per session userId AND per IP. */
  chat: (): RateLimitRule => ruleFromEnv("RATE_LIMIT_CHAT", { limit: 30, windowSeconds: 60 }),
  /** Paid model-backed memory routes (ask, propose, entries POST, memory PUT). Per session userId. */
  model: (): RateLimitRule => ruleFromEnv("RATE_LIMIT_MODEL", { limit: 20, windowSeconds: 60 }),
  /** Same memory routes, per IP — a touch more lenient, since one IP can carry several legit users (NAT). */
  modelIp: (): RateLimitRule => ruleFromEnv("RATE_LIMIT_MODEL_IP", { limit: 40, windowSeconds: 60 }),
  /** Voice transcription. Applied per session userId AND per IP. */
  voice: (): RateLimitRule => ruleFromEnv("RATE_LIMIT_VOICE", { limit: 10, windowSeconds: 60 }),
};

/** A 429 Response with a Retry-After header, for the API routes. */
export function rateLimitResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" },
    },
  );
}

/**
 * Enforce a per-IP then per-user limit for one route family, before any model/DB work. Returns a
 * 429 `Response` to return as-is, or `null` to proceed. The two keys land in different partitions
 * (`<family>:ip:<ip>` and `<family>:user:<userId>`), so the IP and user budgets are independent and
 * an IP flood cannot evict a user's bucket.
 */
export function enforceIpAndUserLimit(
  family: string,
  userId: string,
  request: { headers: { get(name: string): string | null } },
  perIp: RateLimitRule,
  perUser: RateLimitRule,
): Response | null {
  const ip = checkRateLimit(`${family}:ip:${clientIp(request)}`, perIp);
  if (!ip.ok) return rateLimitResponse(ip.retryAfterSeconds);
  const user = checkRateLimit(`${family}:user:${userId}`, perUser);
  if (!user.ok) return rateLimitResponse(user.retryAfterSeconds);
  return null;
}

/** Test-only: clear every bucket so one test's hits do not leak into the next. */
export function __resetRateLimitsForTests(): void {
  defaultStore.reset();
}
