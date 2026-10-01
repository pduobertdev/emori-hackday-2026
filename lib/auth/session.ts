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

export function getSessionSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.EMORI_SESSION_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
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

export function sessionTokenFromRequest(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return token;
  }

  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

function unauthorized(): Response {
  return Response.json({ error: "Sign in required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

/**
 * Resolve the caller's session or a 401 Response. Call this FIRST in every protected route,
 * before any config/provider check, so an unauthenticated caller can never learn whether a
 * database or model is configured.
 */
export function requireSession(request: Request): Session | Response {
  const secret = getSessionSecret();
  if (!secret) {
    console.error("EMORI_SESSION_SECRET is not set; refusing every authenticated request.");
    return unauthorized();
  }
  const session = verifySession(sessionTokenFromRequest(request), { secret });
  return session ?? unauthorized();
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
