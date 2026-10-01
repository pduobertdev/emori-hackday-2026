import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  COOKIE_NAME,
  buildSessionCookie,
  createDemoSession,
  createSession,
  getSessionSecret,
  requireSession,
  sessionTokenFromRequest,
  signSession,
  verifySession,
} from "../lib/auth/session";

// A strong, high-entropy secret (every hex digit twice → ~4 bits/char), so it passes the entropy gate.
const SECRET = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

afterEach(() => {
  delete process.env.EMORI_SESSION_SECRET;
  delete process.env.EMORI_DEMO_ACCESS;
});

function bearer(token: string) {
  return new Request("http://localhost/api", { headers: { authorization: `Bearer ${token}` } });
}

test("getSessionSecret requires at least 32 characters", () => {
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: "short" }), null);
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: SECRET }), SECRET);
  assert.equal(getSessionSecret({}), null);
});

test("getSessionSecret rejects low-entropy secrets", () => {
  // Long enough but trivially weak — one repeated character.
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: "x".repeat(32) }), null);
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: "ab".repeat(16) }), null);
  // A real random-looking secret is accepted.
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: SECRET }), SECRET);
});

test("getSessionSecret trims surrounding whitespace and uses the trimmed value", () => {
  // Trailing newline, CRLF, and leading spaces are all tolerated — the trimmed secret is returned.
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: `${SECRET}\n` }), SECRET);
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: `${SECRET}\r\n` }), SECRET);
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: `  ${SECRET}` }), SECRET);
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: `  ${SECRET}  ` }), SECRET);
  // The strength check still applies to the TRIMMED value: 31 chars + a newline is too short.
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: `${"0a1b2c3d4e5f60718293a4b5c6d7e8f"}\n` }), null);
});

test("a token signed with a padded secret verifies against the trimmed secret", () => {
  const padded = `  ${SECRET}\n`;
  const token = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 3600 }), getSessionSecret({ EMORI_SESSION_SECRET: padded }));
  // Verifying with the trimmed value (what getSessionSecret returns everywhere) succeeds.
  assert.ok(verifySession(token, { secret: SECRET }));
});

test("a signed session round-trips through verify", () => {
  const session = createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 3600 });
  const token = signSession(session, SECRET);
  assert.deepEqual(verifySession(token, { secret: SECRET }), session);
});

test("a tampered payload fails verification", () => {
  const token = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 3600 }), SECRET);
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ tenantId: "acme", userId: "mallory", role: "member", exp: 9999999999 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${sig}`, { secret: SECRET }), null);
  assert.equal(verifySession(`${payload}.${sig}x`, { secret: SECRET }), null);
});

test("a session signed with another secret fails verification", () => {
  const token = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 3600 }), SECRET);
  assert.equal(verifySession(token, { secret: "y".repeat(32) }), null);
});

test("an expired session fails verification", () => {
  const now = 1_000_000_000_000;
  const token = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 60 }, now), SECRET);
  assert.ok(verifySession(token, { secret: SECRET, now: now + 59_000 }));
  assert.equal(verifySession(token, { secret: SECRET, now: now + 61_000 }), null);
});

test("verify fails closed when no secret is configured", () => {
  const token = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 60 }), SECRET);
  assert.equal(verifySession(token, { secret: null }), null);
});

test("malformed tokens never throw", () => {
  for (const bad of ["", "a", "a.b.c", "not-base64.sig", "."]) {
    assert.equal(verifySession(bad, { secret: SECRET }), null);
  }
});

test("the token is read from a Bearer header or the session cookie", () => {
  assert.equal(sessionTokenFromRequest(bearer("tok-123")), "tok-123");
  const withCookie = new Request("http://localhost/api", {
    headers: { cookie: `other=1; ${COOKIE_NAME}=tok-456; another=2` },
  });
  assert.equal(sessionTokenFromRequest(withCookie), "tok-456");
  assert.equal(sessionTokenFromRequest(new Request("http://localhost/api")), undefined);

  // A malformed %-encoding must not throw — it is treated as no token.
  const malformed = new Request("http://localhost/api", { headers: { cookie: `${COOKIE_NAME}=%E0%A4%A` } });
  assert.equal(sessionTokenFromRequest(malformed), undefined);
});

test("requireSession treats a malformed cookie as no session (401, never 500)", () => {
  process.env.EMORI_SESSION_SECRET = SECRET;
  const request = new Request("http://localhost/api", {
    method: "POST",
    headers: { cookie: `${COOKIE_NAME}=%E0%A4%A` },
  });
  const result = requireSession(request);
  assert.ok(result instanceof Response);
  assert.equal((result as Response).status, 401);
});

test("requireSession returns the session for a valid Bearer token", () => {
  process.env.EMORI_SESSION_SECRET = SECRET;
  const session = createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 3600 });
  const result = requireSession(bearer(signSession(session, SECRET)));
  assert.ok(!(result instanceof Response));
  assert.deepEqual(result, session);
});

test("requireSession returns 401 for missing, invalid, and unsigned-secret cases", async () => {
  process.env.EMORI_SESSION_SECRET = SECRET;
  const missing = requireSession(new Request("http://localhost/api"));
  assert.ok(missing instanceof Response);
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: "Sign in required." });

  assert.equal((requireSession(bearer("garbage")) as Response).status, 401);

  const token = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 60 }), SECRET);
  delete process.env.EMORI_SESSION_SECRET;
  assert.equal((requireSession(bearer(token)) as Response).status, 401);
});

test("a demo session is scoped to the demo tenant with a fresh visitor id", () => {
  const a = createDemoSession();
  const b = createDemoSession();
  assert.equal(a.tenantId, "demo");
  assert.equal(a.role, "demo");
  assert.match(a.userId, /^visitor-/);
  assert.notEqual(a.userId, b.userId);
  assert.ok(a.exp * 1000 > Date.now());
});

test("requireSession rejects a demo token unless EMORI_DEMO_ACCESS is on (kill switch)", () => {
  process.env.EMORI_SESSION_SECRET = SECRET;
  const demo = signSession(createSession({ tenantId: "demo", userId: "visitor-1", role: "demo", ttlSeconds: 3600 }), SECRET);
  const member = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 3600 }), SECRET);

  delete process.env.EMORI_DEMO_ACCESS;
  assert.equal((requireSession(bearer(demo)) as Response).status, 401, "demo token blocked when demo is off");
  assert.ok(!(requireSession(bearer(member)) instanceof Response), "member token still works when demo is off");

  process.env.EMORI_DEMO_ACCESS = "on";
  assert.ok(!(requireSession(bearer(demo)) instanceof Response), "demo token works when demo is on");
});

// --- Origin / CSRF check on cookie-authenticated state-changing requests ---

function cookieRequest(
  method: string,
  headers: Record<string, string> = {},
): Request {
  const token = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 3600 }), SECRET);
  return new Request("http://localhost/api", { method, headers: { cookie: `${COOKIE_NAME}=${token}`, ...headers } });
}

test("a cross-origin cookie POST is rejected with 403; same-origin and safe methods pass", () => {
  process.env.EMORI_SESSION_SECRET = SECRET;

  // Same-origin Origin (host matches the request URL host) is allowed.
  assert.ok(!(requireSession(cookieRequest("POST", { origin: "http://localhost" })) instanceof Response));

  // Cross-origin Origin on a state-changing method is blocked.
  const blocked = requireSession(cookieRequest("POST", { origin: "https://evil.example" }));
  assert.ok(blocked instanceof Response);
  assert.equal((blocked as Response).status, 403);

  // A safe method (GET) is never origin-checked.
  assert.ok(!(requireSession(cookieRequest("GET", { origin: "https://evil.example" })) instanceof Response));
});

test("the origin check falls back to Sec-Fetch-Site, and allows when neither header is present", () => {
  process.env.EMORI_SESSION_SECRET = SECRET;

  assert.equal(
    (requireSession(cookieRequest("POST", { "sec-fetch-site": "cross-site" })) as Response).status,
    403,
    "Sec-Fetch-Site: cross-site is rejected when no Origin is present",
  );
  assert.ok(
    !(requireSession(cookieRequest("POST", { "sec-fetch-site": "same-origin" })) instanceof Response),
    "same-origin fetch is allowed",
  );
  assert.ok(
    !(requireSession(cookieRequest("POST")) instanceof Response),
    "no Origin and no Sec-Fetch-Site (non-browser client) is allowed",
  );
});

test("a Bearer-authenticated cross-origin POST is exempt from the origin check", () => {
  process.env.EMORI_SESSION_SECRET = SECRET;
  const token = signSession(createSession({ tenantId: "acme", userId: "alice", role: "member", ttlSeconds: 3600 }), SECRET);
  const request = new Request("http://localhost/api", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
  });
  assert.ok(!(requireSession(request) instanceof Response), "Bearer clients are not subject to CSRF origin checks");
});

test("buildSessionCookie marks the cookie HttpOnly and SameSite=Lax", () => {
  const cookie = buildSessionCookie("tok", { secure: true, maxAgeSeconds: 3600 });
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=tok;`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=3600/);
  assert.doesNotMatch(buildSessionCookie("tok", { secure: false, maxAgeSeconds: 10 }), /Secure/);
});
