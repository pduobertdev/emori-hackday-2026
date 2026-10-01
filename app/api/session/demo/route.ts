import {
  DEMO_SESSION_TTL_SECONDS,
  buildSessionCookie,
  createDemoSession,
  getSessionSecret,
  signSession,
} from "@/lib/auth/session";
import { RATE_LIMITS, checkRateLimit, clientIp, rateLimitResponse } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

/** True only when the deployment opted the public demo in. Defaults to off. */
function demoAccessEnabled(): boolean {
  return process.env.EMORI_DEMO_ACCESS?.trim().toLowerCase() === "on";
}

/**
 * Issue a short-lived demo session so the public demo works with no login. Every call mints a
 * fresh anonymous visitor in the "demo" tenant: they read the shared fictional seed plus their
 * own writes, and nothing else. Disabled unless EMORI_DEMO_ACCESS=on, in which case it is a 404
 * so its existence is not advertised.
 */
export async function POST(request: Request) {
  if (!demoAccessEnabled()) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const limited = checkRateLimit(`demo-mint:${clientIp(request)}`, RATE_LIMITS.demoMint());
  if (!limited.ok) return rateLimitResponse(limited.retryAfterSeconds);

  const secret = getSessionSecret();
  if (!secret) {
    return Response.json({ error: "Sessions are not configured." }, { status: 503 });
  }

  const session = createDemoSession();
  const token = signSession(session, secret);
  const cookie = buildSessionCookie(token, {
    secure: process.env.NODE_ENV === "production",
    maxAgeSeconds: DEMO_SESSION_TTL_SECONDS,
  });

  // The token is set as an HttpOnly cookie only — it is deliberately not in the body, so it can't
  // be lifted by client JS or a cross-origin reader and replayed to automate the paid routes.
  return Response.json(
    { ok: true, role: session.role, tenantId: session.tenantId },
    { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } },
  );
}
