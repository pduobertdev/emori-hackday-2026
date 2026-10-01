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

const SECRET = "x".repeat(32);

afterEach(() => {
  delete process.env.EMORI_SESSION_SECRET;
});

function bearer(token: string) {
  return new Request("http://localhost/api", { headers: { authorization: `Bearer ${token}` } });
}

test("getSessionSecret requires at least 32 characters", () => {
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: "short" }), null);
  assert.equal(getSessionSecret({ EMORI_SESSION_SECRET: SECRET }), SECRET);
  assert.equal(getSessionSecret({}), null);
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

test("buildSessionCookie marks the cookie HttpOnly and SameSite=Lax", () => {
  const cookie = buildSessionCookie("tok", { secure: true, maxAgeSeconds: 3600 });
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=tok;`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=3600/);
  assert.doesNotMatch(buildSessionCookie("tok", { secure: false, maxAgeSeconds: 10 }), /Secure/);
});
