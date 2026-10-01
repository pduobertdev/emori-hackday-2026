import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed sessions. A token is `base64url(JSON payload).base64url(HMAC-SHA256)`.
 * There is no server-side session store: the signature is the only thing that makes a token
 * trustworthy, so the secret must be set and kept private. With no secret we fail closed —
 * every request is rejected rather than silently treated as public.
 */

export type Role = "demo" | "member";
export type Session = { tenantId: string; userId: string; role: Role; exp: number };

export const COOKIE_NAME = "emori_session";
export const DEMO_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_SECRET_LENGTH = 32;
/**
 * Minimum Shannon entropy per character. A good random secret (e.g. 32 bytes as hex) is ~4 bits/char;
 * padded or repeated values ("aaaa…", "passwordpassword…") fall well below 3. This rejects the weak
 * secrets a length check alone lets through, without false-positives on real random secrets.
 */
const MIN_SECRET_ENTROPY_BITS = 3;

/** Only warn once per process about a bad secret, so a per-request check does not spam the log. */
let warnedBadSecret = false;
function warnBadSecret(reason: string): void {
  if (warnedBadSecret) return;
  warnedBadSecret = true;
  // Never log the value itself — only why it was refused.
  console.error(`EMORI_SESSION_SECRET ${reason}; refusing every authenticated request.`);
}

/** Shannon entropy in bits per character. 0 for a single repeated character. */
function entropyBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The signing secret, or null when it is unset or too weak (length, padding, or low entropy). When
 * null, every authenticated route fails closed. A weak secret is as dangerous as none — a forgeable
 * MAC makes every token trustable — so we refuse it the same way.
 */
export function getSessionSecret(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.EMORI_SESSION_SECRET;
  if (!raw) return null;
  if (raw !== raw.trim()) {
    warnBadSecret("has leading or trailing whitespace");
    return null;
  }
  if (raw.length < MIN_SECRET_LENGTH) return null;
  if (entropyBitsPerChar(raw) < MIN_SECRET_ENTROPY_BITS) {
    warnBadSecret("is too low-entropy (repeated or too few distinct characters)");
    return null;
  }
  return raw;
}

/** True only when the deployment opted the public demo in. Defaults to off. */
export function demoAccessEnabled(): boolean {
  return process.env.EMORI_DEMO_ACCESS?.trim().toLowerCase() === "on";
}

export function createSession(
  input: { tenantId: string; userId: string; role: Role; ttlSeconds: number },
  now: number = Date.now(),
): Session {
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    role: input.role,
    exp: Math.floor(now / 1000) + input.ttlSeconds,
  };
}

export function createDemoSession(now: number = Date.now()): Session {
  return createSession(
    { tenantId: "demo", userId: `visitor-${randomUUID()}`, role: "demo", ttlSeconds: DEMO_SESSION_TTL_SECONDS },
    now,
  );
}

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(session: Session, secret: string | null = getSessionSecret()): string {
  if (!secret) throw new Error("EMORI_SESSION_SECRET is not set or is shorter than 32 characters.");
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${hmac(payload, secret)}`;
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tenantId === "string" &&
    typeof candidate.userId === "string" &&
    (candidate.role === "demo" || candidate.role === "member") &&
    typeof candidate.exp === "number"
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function verifySession(
  token: string | undefined | null,
  options: { secret?: string | null; now?: number } = {},
): Session | null {
  const secret = options.secret !== undefined ? options.secret : getSessionSecret();
  if (!secret || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;

  if (!constantTimeEqual(signature, hmac(payload, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isSession(parsed)) return null;

  const now = options.now ?? Date.now();
  if (parsed.exp * 1000 <= now) return null;
  return parsed;
}

/** A token plus whether it arrived as a Bearer header (vs a cookie). Bearer callers are CSRF-exempt. */
type TokenSource = { token: string; viaBearer: boolean };

function readToken(request: Request): TokenSource | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return { token, viaBearer: true };
  }

  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === COOKIE_NAME) {
      const raw = part.slice(index + 1).trim();
      try {
        return { token: decodeURIComponent(raw), viaBearer: false };
      } catch {
        // Malformed %-encoding — treat as no session (401) rather than letting decodeURIComponent throw.
        return undefined;
      }
    }
  }
  return undefined;
}

export function sessionTokenFromRequest(request: Request): string | undefined {
  return readToken(request)?.token;
}

function unauthorized(): Response {
  return Response.json({ error: "Sign in required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function forbidden(): Response {
  return Response.json({ error: "Cross-site request blocked." }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/** Hosts that count as "this app": the request URL host plus any proxy-set Host / X-Forwarded-Host. */
function allowedHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value) hosts.add(value.trim().toLowerCase());
  };
  add(request.headers.get("host"));
  for (const part of request.headers.get("x-forwarded-host")?.split(",") ?? []) add(part);
  try {
    add(new URL(request.url).host);
  } catch {
    /* non-absolute URL — ignore */
  }
  return hosts;
}

/**
 * CSRF defense for cookie-authenticated writes. A browser attaches the session cookie automatically
 * on a cross-site form/fetch POST, so we check the request is same-origin:
 *  - Origin present → its host must be one of this app's hosts, else reject.
 *  - Origin absent → fall back to Sec-Fetch-Site (reject only an explicit "cross-site").
 *  - Neither header → allow (a non-browser client that sends no Origin).
 */
function sameOriginOk(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    return allowedHosts(request).has(originHost);
  }

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) return secFetchSite !== "cross-site";

  return true;
}

/**
 * Resolve the caller's session, or a Response (401/403). Call this FIRST in every protected route,
 * before any config/provider check, so an unauthenticated caller can never learn whether a
 * database or model is configured.
 *
 * Also: a demo-role token is rejected unless EMORI_DEMO_ACCESS is on (so turning the demo off is a
 * real kill switch for tokens already issued), and cookie-authenticated state-changing requests must
 * be same-origin (CSRF). Bearer callers are exempt from the origin check.
 */
export function requireSession(request: Request): Session | Response {
  const secret = getSessionSecret();
  if (!secret) {
    warnBadSecret("is not set");
    return unauthorized();
  }

  const source = readToken(request);
  const session = verifySession(source?.token, { secret });
  if (!session) return unauthorized();

  if (session.role === "demo" && !demoAccessEnabled()) return unauthorized();

  if (!source?.viaBearer && STATE_CHANGING_METHODS.has(request.method) && !sameOriginOk(request)) {
    return forbidden();
  }

  return session;
}

export function buildSessionCookie(
  token: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}
