import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  COOKIE_NAME,
  DEMO_SESSION_TTL_SECONDS,
  createDemoSession,
  getSessionSecret,
  signSession,
  verifySession,
} from "@/lib/auth/session";
import { RATE_LIMITS, checkRateLimit, clientIp } from "@/lib/auth/rate-limit";

/**
 * Keeps the public demo working with no login: on a page load, if the demo is enabled and the
 * visitor has no valid session yet, mint a fresh scoped demo session and set it as an HttpOnly
 * cookie. Every later same-origin API call carries it automatically. When EMORI_DEMO_ACCESS is
 * not "on", or no session secret is set, nothing is issued and the API routes stay locked.
 *
 * Proxy runs on the Node.js runtime in this Next version, so node:crypto signing works here.
 */
export function proxy(request: NextRequest) {
  if (process.env.EMORI_DEMO_ACCESS?.trim().toLowerCase() !== "on") return NextResponse.next();

  const secret = getSessionSecret();
  if (!secret) return NextResponse.next();

  if (verifySession(request.cookies.get(COOKIE_NAME)?.value, { secret })) return NextResponse.next();

  // Only the mint path is rate-limited: a visitor with a valid cookie returned above, so a normal
  // user mints once per TTL, while a script that discards cookies and re-mints on every load is
  // throttled per IP. This uses the same key NAME as POST /api/session/demo (`demo-mint:<ip>`) but
  // NOT the same counter: the proxy and the route run as separate functions/instances, each with its
  // own in-memory Map, so the two budgets are independent — not a shared cap.
  const limited = checkRateLimit(`demo-mint:${clientIp(request)}`, RATE_LIMITS.demoMint());
  if (!limited.ok) {
    const blocked = NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429 },
    );
    blocked.headers.set("Retry-After", String(limited.retryAfterSeconds));
    return blocked;
  }

  const response = NextResponse.next();
  response.cookies.set({
    name: COOKIE_NAME,
    value: signSession(createDemoSession(), secret),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DEMO_SESSION_TTL_SECONDS,
  });
  return response;
}

// Page loads only — never API routes (they authenticate themselves) or static assets.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
