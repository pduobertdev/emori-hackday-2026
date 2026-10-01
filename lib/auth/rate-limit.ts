/**
 * A tiny per-key fixed-window rate limiter with no dependencies. Counts hits against a key in an
 * in-memory Map; when the window elapses the count resets. This is best-effort and PER INSTANCE:
 * on serverless (Vercel) each warm instance keeps its own Map, so the real cap is roughly the
 * configured limit times the number of live instances. A shared store (Vercel KV / Upstash free
 * tier) is the follow-up for a global limit; see the README.
 */

export type RateLimitRule = { limit: number; windowSeconds: number };

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let lastPrune = 0;
const PRUNE_INTERVAL_MS = 60_000;

/** Drop expired buckets occasionally so the Map cannot grow without bound. */
function prune(now: number): void {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function checkRateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
  prune(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1000 });
    return { ok: true };
  }

  if (existing.count >= rule.limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }

  existing.count += 1;
  return { ok: true };
}

/**
 * The caller's IP: the first hop in `x-forwarded-for`, else `x-real-ip`, else "unknown". The
 * fallback means a proxy that strips these headers rate-limits every such caller as one bucket —
 * safe (over-limits), never under-limits.
 */
export function clientIp(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
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
  /** Voice transcription. */
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

/** Test-only: clear every bucket so one test's hits do not leak into the next. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
  lastPrune = 0;
}
