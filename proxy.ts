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
