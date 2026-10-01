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
/**
 * Hard ceiling on distinct live keys. Expired buckets are pruned lazily every 60s, but keys created
 * within a window accumulate until then, so cap the Map to bound memory. When it is full of live
 * buckets we fail closed (reject new keys with 429): cheaper to turn away a new caller than to let
 * the Map — and the paid model/voice calls it guards — grow without bound.
 */
const MAX_BUCKETS = 10_000;

/** Delete every expired bucket right now. */
function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  lastPrune = now;
}

/** Drop expired buckets occasionally so the Map cannot grow without bound. */
function prune(now: number): void {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  pruneExpired(now);
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function checkRateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
  prune(now);

  const existing = buckets.get(key);
  if (existing && existing.resetAt > now) {
    if (existing.count >= rule.limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
    }
    existing.count += 1;
    return { ok: true };
  }

  // Brand-new key (an expired `existing` is replaced in place and does not grow the Map). Guard the
  // cap first: prune expired buckets, and if the Map is still full of live ones, fail closed.
  if (!existing && buckets.size >= MAX_BUCKETS) {
    pruneExpired(now);
    if (buckets.size >= MAX_BUCKETS) return { ok: false, retryAfterSeconds: rule.windowSeconds };
  }

  buckets.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1000 });
  return { ok: true };
}

/**
 * The caller's IP, used only as a rate-limit bucket key.
 *
 * TRUST ASSUMPTION: this app is deployed behind Vercel. Vercel sets `x-vercel-forwarded-for` and
 * `x-real-ip` from the real connecting socket and overwrites any client-supplied copies, so those
 * are trustworthy. (`NextRequest.ip` was removed in this Next version, so we read headers.)
 *
 * We never trust the FIRST `x-forwarded-for` hop: a client can send any `X-Forwarded-For`, and a
 * proxy APPENDS the real IP after it, so the first token stays attacker-controlled — rotating it
 * would mint unlimited buckets and bypass every limit. If we must fall back to raw XFF we take the
 * LAST hop (the one our nearest proxy added).
 *
 * Order: x-vercel-forwarded-for, x-real-ip, last x-forwarded-for hop, "unknown". The "unknown"
 * fallback buckets all such callers together — safe (over-limits), never under-limits.
 */
export function clientIp(request: { headers: { get(name: string): string | null } }): string {
  const vercel = request.headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return vercel;

  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",");
    const last = hops[hops.length - 1]?.trim();
    if (last) return last;
  }
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
