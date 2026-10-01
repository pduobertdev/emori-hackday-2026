import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { GET as chatGet, POST as chatPost } from "../app/api/chat/route";
import { PUT as memoryPut, GET as memoryGet } from "../app/api/memory/route";
import { POST as entriesPost } from "../app/api/memory/entries/route";
import { DELETE as entriesDelete } from "../app/api/memory/entries/[id]/route";
import { GET as graphGet } from "../app/api/memory/graph/route";
import { POST as askPost } from "../app/api/memory/ask/route";
import { POST as proposePost } from "../app/api/memory/propose/route";
import { POST as imagePost } from "../app/api/memory/image/route";
import { POST as demoSession } from "../app/api/session/demo/route";
import { POST as voicePost } from "../app/api/voice/transcribe/route";
import { __resetRateLimitsForTests } from "../lib/auth/rate-limit";
import { createSession, signSession, verifySession, type Role } from "../lib/auth/session";
import {
  resetMemoryBackendForTests,
  setMemoryBackendForTests,
  type MemoryBackend,
} from "../lib/memory/graph/backend";
import { sourceForOwner, type MemoryRecord, type ReadScope, type WriteScope } from "../lib/memory/graph/types";
import { startMockModel } from "./helpers/mock-model";

const SECRET = "route-auth-secret-0123456789-abcdef";

// A real Aura-looking URI and a model make the config/provider checks pass, so the tests
// exercise the auth and scoping layers rather than a 503 for missing infrastructure.
const CONFIG_ENV = {
  NEO4J_URI: "neo4j+s://testinstance.databases.neo4j.io",
  NEO4J_USERNAME: "neo4j",
  NEO4J_PASSWORD: "test-pass",
  AI_PROVIDER: "openrouter",
  AI_MODEL: "test-model",
  OPENROUTER_API_KEY: "test-key",
} as const;

let model: Awaited<ReturnType<typeof startMockModel>>;

function applyConfigEnv() {
  process.env.EMORI_SESSION_SECRET = SECRET;
  // Demo tokens are used throughout these tests; requireSession now gates them on this flag.
  process.env.EMORI_DEMO_ACCESS = "on";
  // clientIp trusts x-real-ip / x-vercel-forwarded-for only on Vercel, so the per-IP tests below
  // need this set to exercise distinct IP buckets (off-Vercel every IP collapses to "unknown").
  process.env.VERCEL = "1";
  for (const [key, value] of Object.entries(CONFIG_ENV)) process.env[key] = value;
  process.env.AI_BASE_URL = model.baseURL;
  delete process.env.CRUSOE_API_KEY;
}

function clearConfigEnv() {
  for (const key of Object.keys(CONFIG_ENV)) delete process.env[key];
  delete process.env.AI_BASE_URL;
  delete process.env.VERCEL;
}

function token(input: { tenantId: string; userId: string; role: Role; ttlSeconds?: number }): string {
  return signSession(createSession({ ttlSeconds: 3600, ...input }), SECRET);
}

// --- an in-memory backend that honours the same tenant/owner contract as the repository ---

type Row = { id: string; tenantId: string; ownerId: string; text: string; createdAt: string; eventDate?: string };

function toRecord(row: Row): MemoryRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    source: sourceForOwner(row.ownerId),
    text: row.text,
    createdAt: row.createdAt,
    extraction: "done",
    ...(row.eventDate ? { eventDate: row.eventDate } : {}),
  };
}

function inScope(row: Row, scope: ReadScope): boolean {
  return row.tenantId === scope.tenantId && scope.ownerIds.includes(row.ownerId);
}

function makeFakeBackend(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let seq = 0;
  const seen: { reads: ReadScope[]; questions: ReadScope[]; lists: ReadScope[] } = {
    reads: [],
    questions: [],
    lists: [],
  };

  const backend: MemoryBackend = {
    async saveMemory(input) {
      const row: Row = {
        id: `m-${++seq}`,
        tenantId: input.tenantId,
        ownerId: input.ownerId,
        text: input.text.trim(),
        createdAt: new Date(Date.now() + seq).toISOString(),
        ...(input.eventDate ? { eventDate: input.eventDate } : {}),
      };
      rows.push(row);
      return { memory: toRecord(row), entities: 0, relations: 0 };
    },
    async listMemories(scope) {
      seen.lists.push(scope);
      return rows.filter((row) => inScope(row, scope)).map(toRecord);
    },
    async recallMemories(_query, scope) {
      seen.reads.push(scope);
      return rows.filter((row) => inScope(row, scope)).map((row) => ({ ...toRecord(row), reason: "recent" as const }));
    },
    async memoriesForQuestion(_question, scope) {
      seen.questions.push(scope);
      return rows.filter((row) => inScope(row, scope)).map(toRecord);
    },
    async getMemoryGraph(scope) {
      const nodes = rows.filter((row) => inScope(row, scope)).map((row) => ({ type: "memory" as const, ...toRecord(row) }));
      return { nodes, links: [], stats: { memories: nodes.length, entities: 0, links: 0 } };
    },
    async deleteMemory(scope: WriteScope, id) {
      const index = rows.findIndex((row) => row.id === id && row.tenantId === scope.tenantId && row.ownerId === scope.ownerId);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
  };

  return { backend, rows, seen };
}

function json(method: string, body: unknown, tok?: string): Request {
  return new Request("http://localhost/api", {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}

function bare(method: string, tok?: string): Request {
  return new Request("http://localhost/api", {
    method,
    headers: tok ? { authorization: `Bearer ${tok}` } : {},
  });
}

const deleteCtx = (id: string) => ({ params: Promise.resolve({ id }) });

before(async () => {
  model = await startMockModel();
  model.reply("ok [1]");
});

after(async () => {
  resetMemoryBackendForTests();
  await model.close();
  clearConfigEnv();
  delete process.env.EMORI_SESSION_SECRET;
  delete process.env.EMORI_DEMO_ACCESS;
});

beforeEach(() => {
  applyConfigEnv();
  __resetRateLimitsForTests();
  setMemoryBackendForTests(makeFakeBackend().backend);
});

afterEach(() => {
  resetMemoryBackendForTests();
  delete process.env.RATE_LIMIT_CHAT;
  delete process.env.RATE_LIMIT_VOICE;
  delete process.env.RATE_LIMIT_DEMO_MINT;
  delete process.env.RATE_LIMIT_MODEL;
  delete process.env.RATE_LIMIT_MODEL_IP;
});

// Every protected route, exercised with no token and with a tampered token, with all
// infrastructure env cleared — so a 401 (never a 503) proves auth runs before config.
const PROTECTED: Array<{ name: string; call: (tok?: string) => Promise<Response> }> = [
  { name: "GET /api/memory", call: (t) => memoryGet(bare("GET", t)) },
  { name: "PUT /api/memory", call: (t) => memoryPut(json("PUT", { text: "hi" }, t)) },
  { name: "POST /api/memory/entries", call: (t) => entriesPost(json("POST", { text: "hi" }, t)) },
  { name: "DELETE /api/memory/entries/[id]", call: (t) => entriesDelete(bare("DELETE", t), deleteCtx("m-1")) },
  { name: "GET /api/memory/graph", call: (t) => graphGet(bare("GET", t)) },
  { name: "POST /api/memory/ask", call: (t) => askPost(json("POST", { question: "what?" }, t)) },
  { name: "POST /api/memory/propose", call: (t) => proposePost(json("POST", { messages: [{ role: "user", content: "hi there friend" }] }, t)) },
  { name: "POST /api/memory/image", call: (t) => imagePost(bare("POST", t)) },
  { name: "GET /api/chat", call: (t) => chatGet(bare("GET", t)) },
  { name: "POST /api/chat", call: (t) => chatPost(json("POST", { messages: [{ role: "user", content: "hi" }] }, t)) },
  { name: "POST /api/voice/transcribe", call: (t) => voicePost(bare("POST", t)) },
];

test("every protected route rejects a missing or invalid token with 401, before any config check", async () => {
  clearConfigEnv();
  try {
    for (const route of PROTECTED) {
      assert.equal((await route.call()).status, 401, `${route.name} with no token`);
      assert.equal((await route.call("garbage")).status, 401, `${route.name} with invalid token`);
      const expired = token({ tenantId: "demo", userId: "visitor-1", role: "demo", ttlSeconds: -10 });
      assert.equal((await route.call(expired)).status, 401, `${route.name} with expired token`);
    }
  } finally {
    applyConfigEnv();
  }
});

test("an owner can add, read and delete their own memory", async () => {
  const { backend, rows } = makeFakeBackend();
  setMemoryBackendForTests(backend);
  const tok = token({ tenantId: "demo", userId: "visitor-1", role: "demo" });

  const created = await entriesPost(json("POST", { text: "I planted basil today." }, tok));
  assert.equal(created.status, 201);
  const body = (await created.json()) as { memory: { id: string } };
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenantId, "demo");
  assert.equal(rows[0].ownerId, "visitor-1");

  const graph = await graphGet(bare("GET", tok));
  assert.equal(graph.status, 200);
  const graphBody = (await graph.json()) as { nodes: Array<{ id: string }> };
  assert.ok(graphBody.nodes.some((node) => node.id === body.memory.id));

  assert.equal((await entriesDelete(bare("DELETE", tok), deleteCtx(body.memory.id))).status, 200);
  assert.equal((await entriesDelete(bare("DELETE", tok), deleteCtx(body.memory.id))).status, 404);
});

test("a tenant cannot read, ask about, or delete another tenant's memory", async () => {
  const { backend, rows, seen } = makeFakeBackend([
    { id: "mA", tenantId: "tenant-a", ownerId: "alice", text: "Alice's private note.", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "mB", tenantId: "tenant-b", ownerId: "bob", text: "Bob's note.", createdAt: "2026-01-02T00:00:00.000Z" },
  ]);
  setMemoryBackendForTests(backend);
  const bob = token({ tenantId: "tenant-b", userId: "bob", role: "member" });

  const graph = (await (await graphGet(bare("GET", bob))).json()) as { nodes: Array<{ id: string }> };
  assert.ok(graph.nodes.some((node) => node.id === "mB"));
  assert.ok(!graph.nodes.some((node) => node.id === "mA"), "tenant B never sees tenant A's memory");

  const ask = (await (await askPost(json("POST", { question: "what notes exist?" }, bob))).json()) as {
    evidence: Array<{ id: string }>;
  };
  assert.ok(!ask.evidence.some((item) => item.id === "mA"), "the model is never given tenant A's memory");
  assert.equal(seen.questions.at(-1)?.tenantId, "tenant-b");
  assert.ok(!seen.questions.at(-1)?.ownerIds.includes("alice"));

  assert.equal((await entriesDelete(bare("DELETE", bob), deleteCtx("mA"))).status, 404, "cannot delete across tenants");
  assert.ok(rows.some((row) => row.id === "mA"), "tenant A's memory still exists");
});

test("chat recall is scoped to the caller's tenant", async () => {
  const { backend, seen } = makeFakeBackend([
    { id: "mA", tenantId: "tenant-a", ownerId: "alice", text: "Alice's private note.", createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  setMemoryBackendForTests(backend);
  const bob = token({ tenantId: "tenant-b", userId: "bob", role: "member" });

  const response = await chatPost(json("POST", { messages: [{ role: "user", content: "tell me a note" }] }, bob));
  assert.equal(response.status, 200);
  await response.text(); // drain the stream so it finishes before teardown

  assert.equal(seen.reads.at(-1)?.tenantId, "tenant-b");
  assert.ok(!seen.reads.at(-1)?.ownerIds.includes("alice"), "tenant A's owner is never in tenant B's recall scope");
});

test("within the demo tenant, one visitor cannot see or delete another visitor's memory", async () => {
  const { backend, rows } = makeFakeBackend([
    { id: "seed-leo", tenantId: "demo", ownerId: "leo", text: "A seeded Leo memory.", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "m1", tenantId: "demo", ownerId: "visitor-1", text: "Visitor one's own memory.", createdAt: "2026-01-02T00:00:00.000Z" },
  ]);
  setMemoryBackendForTests(backend);
  const visitor2 = token({ tenantId: "demo", userId: "visitor-2", role: "demo" });

  const graph = (await (await graphGet(bare("GET", visitor2))).json()) as { nodes: Array<{ id: string }> };
  assert.ok(graph.nodes.some((node) => node.id === "seed-leo"), "a visitor reads the shared seed");
  assert.ok(!graph.nodes.some((node) => node.id === "m1"), "a visitor never sees another visitor's memory");

  assert.equal((await entriesDelete(bare("DELETE", visitor2), deleteCtx("m1"))).status, 404);
  assert.ok(rows.some((row) => row.id === "m1"), "visitor one's memory still exists");
});

const mintRequest = () => new Request("http://localhost/api/session/demo", { method: "POST" });

test("the demo session route is gated by EMORI_DEMO_ACCESS", async () => {
  delete process.env.EMORI_DEMO_ACCESS;
  assert.equal((await demoSession(mintRequest())).status, 404, "off by default");

  process.env.EMORI_DEMO_ACCESS = "on";
  const response = await demoSession(mintRequest());
  assert.equal(response.status, 200);

  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /emori_session=/);
  assert.match(setCookie, /HttpOnly/);

  // The token is delivered only in the HttpOnly cookie, never the JSON body.
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.tenantId, "demo");
  assert.ok(!("token" in body), "the raw token is not returned in the body");

  const token = setCookie.match(/emori_session=([^;]+)/)?.[1] ?? "";
  const session = verifySession(token, { secret: SECRET });
  assert.equal(session?.role, "demo");
  assert.match(session?.userId ?? "", /^visitor-/);
});

test("a demo visitor cannot delete a seed memory, and it survives", async () => {
  const { backend, rows } = makeFakeBackend([
    { id: "seed-leo-0", tenantId: "demo", ownerId: "leo", text: "A seeded Leo memory.", createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  setMemoryBackendForTests(backend);
  const visitor = token({ tenantId: "demo", userId: "visitor-9", role: "demo" });

  assert.equal((await entriesDelete(bare("DELETE", visitor), deleteCtx("seed-leo-0"))).status, 404);
  assert.ok(rows.some((row) => row.id === "seed-leo-0"), "the seed memory still exists");
});

test("POST /api/chat returns 429 with a Retry-After once the per-caller limit is hit", async () => {
  process.env.RATE_LIMIT_CHAT = "1:60";
  __resetRateLimitsForTests();
  const tok = token({ tenantId: "demo", userId: "visitor-chat", role: "demo" });

  const first = await chatPost(json("POST", { messages: [{ role: "user", content: "hi" }] }, tok));
  assert.equal(first.status, 200);
  await first.text(); // drain the stream

  const second = await chatPost(json("POST", { messages: [{ role: "user", content: "hi again" }] }, tok));
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get("Retry-After")) > 0, "a Retry-After is set");
  assert.match(JSON.stringify(await second.json()), /error/);
});

test("POST /api/voice/transcribe returns 429 once the per-IP limit is hit", async () => {
  process.env.RATE_LIMIT_VOICE = "1:60";
  __resetRateLimitsForTests();
  const tok = token({ tenantId: "demo", userId: "visitor-voice", role: "demo" });

  // First call passes the limiter (then fails later for missing key); the second is limited.
  await voicePost(bare("POST", tok));
  const second = await voicePost(bare("POST", tok));
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get("Retry-After")) > 0);
});

test("POST /api/session/demo returns 429 once the per-IP mint limit is hit", async () => {
  process.env.EMORI_DEMO_ACCESS = "on";
  process.env.RATE_LIMIT_DEMO_MINT = "1:600";
  __resetRateLimitsForTests();

  assert.equal((await demoSession(mintRequest())).status, 200);
  const second = await demoSession(mintRequest());
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get("Retry-After")) > 0);
  delete process.env.EMORI_DEMO_ACCESS;
});

// --- Rate limits on the paid model/voice routes (H1) ---

function ipReq(method: string, body: unknown, tok: string, ip: string): Request {
  return new Request("http://localhost/api", {
    method,
    headers: { "Content-Type": "application/json", authorization: `Bearer ${tok}`, "x-real-ip": ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function drain(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    /* already consumed or no body */
  }
}

function freshBackend() {
  const fake = makeFakeBackend();
  setMemoryBackendForTests(fake.backend);
  return fake;
}

// Each paid model route, with a way to observe whether its model/DB work ran (so we can prove the
// 429 short-circuits before any cost). `calls` reads a counter the fake backend bumps on the work
// the handler does: ask → memoriesForQuestion, propose → listMemories, entries/PUT → saveMemory.
type Fake = ReturnType<typeof makeFakeBackend>;
const MODEL_PROBES: Array<{
  name: string;
  call: (tok: string, ip: string) => Promise<Response>;
  calls: (fake: Fake) => number;
}> = [
  {
    name: "POST /api/memory/ask",
    call: (t, ip) => askPost(ipReq("POST", { question: "what is stored here?" }, t, ip)),
    calls: (f) => f.seen.questions.length,
  },
  {
    name: "POST /api/memory/propose",
    call: (t, ip) => proposePost(ipReq("POST", { messages: [{ role: "user", content: "i like hiking and tea" }] }, t, ip)),
    calls: (f) => f.seen.lists.length,
  },
  {
    name: "POST /api/memory/entries",
    call: (t, ip) => entriesPost(ipReq("POST", { text: "a brand new memory" }, t, ip)),
    calls: (f) => f.rows.length,
  },
  {
    name: "PUT /api/memory",
    call: (t, ip) => memoryPut(ipReq("PUT", { text: "a brand new memory" }, t, ip)),
    calls: (f) => f.rows.length,
  },
];

for (const probe of MODEL_PROBES) {
  test(`${probe.name} enforces a per-USER model limit, even from rotating IPs`, async () => {
    process.env.RATE_LIMIT_MODEL = "1:60"; // per-user limit = 1
    process.env.RATE_LIMIT_MODEL_IP = "100:60"; // per-IP generous, so the user limit is what fires
    __resetRateLimitsForTests();
    const fake = freshBackend();
    const tok = token({ tenantId: "demo", userId: `user-${probe.name}`, role: "demo" });

    const first = await probe.call(tok, "1.1.1.1");
    assert.notEqual(first.status, 429, "the first call is allowed through");
    await drain(first);
    const before = probe.calls(fake);

    const second = await probe.call(tok, "2.2.2.2"); // same user, different IP
    assert.equal(second.status, 429, "the per-user limit blocks even from a fresh IP");
    assert.ok(Number(second.headers.get("Retry-After")) > 0, "a Retry-After is set");
    assert.equal(probe.calls(fake), before, "the model/DB is not touched on the 429 request");
  });

  test(`${probe.name} enforces a per-IP model limit, even from rotating users`, async () => {
    process.env.RATE_LIMIT_MODEL = "100:60"; // per-user generous
    process.env.RATE_LIMIT_MODEL_IP = "1:60"; // per-IP limit = 1
    __resetRateLimitsForTests();
    const fake = freshBackend();

    const first = await probe.call(token({ tenantId: "demo", userId: "user-A", role: "demo" }), "9.9.9.9");
    assert.notEqual(first.status, 429, "the first call is allowed through");
    await drain(first);
    const before = probe.calls(fake);

    const second = await probe.call(token({ tenantId: "demo", userId: "user-B", role: "demo" }), "9.9.9.9");
    assert.equal(second.status, 429, "the per-IP limit blocks a different user on the same IP");
    assert.equal(probe.calls(fake), before, "the model/DB is not touched on the 429 request");
  });
}

test("POST /api/voice/transcribe enforces a per-USER limit, even from rotating IPs", async () => {
  process.env.RATE_LIMIT_VOICE = "1:60";
  __resetRateLimitsForTests();
  const tok = token({ tenantId: "demo", userId: "voice-user", role: "demo" });

  const first = await voicePost(ipReq("POST", undefined, tok, "1.1.1.1"));
  assert.notEqual(first.status, 429, "first call passes the limiter (then 503 for the missing key)");
  const second = await voicePost(ipReq("POST", undefined, tok, "2.2.2.2"));
  // 429 (not 503) proves the limiter short-circuited before the transcription call.
  assert.equal(second.status, 429, "the per-user voice limit blocks even from a fresh IP");
  assert.ok(Number(second.headers.get("Retry-After")) > 0);
});

test("POST /api/voice/transcribe enforces a per-IP limit, even from rotating users", async () => {
  process.env.RATE_LIMIT_VOICE = "1:60";
  __resetRateLimitsForTests();

  const first = await voicePost(ipReq("POST", undefined, token({ tenantId: "demo", userId: "vA", role: "demo" }), "7.7.7.7"));
  assert.notEqual(first.status, 429);
  const second = await voicePost(ipReq("POST", undefined, token({ tenantId: "demo", userId: "vB", role: "demo" }), "7.7.7.7"));
  assert.equal(second.status, 429, "the per-IP voice limit blocks a different user on the same IP");
});

test("POST /api/chat enforces a per-USER limit independently of the per-IP limit (M24)", async () => {
  process.env.RATE_LIMIT_CHAT = "1:60";
  __resetRateLimitsForTests();
  const tok = token({ tenantId: "demo", userId: "chat-user", role: "demo" });

  const first = await chatPost(ipReq("POST", { messages: [{ role: "user", content: "hi" }] }, tok, "1.1.1.1"));
  assert.equal(first.status, 200);
  await drain(first);

  const second = await chatPost(ipReq("POST", { messages: [{ role: "user", content: "hi again" }] }, tok, "2.2.2.2"));
  assert.equal(second.status, 429, "same user, new IP → still blocked by the per-user limit");
});

test("POST /api/chat enforces a per-IP limit independently of the per-user limit (M25)", async () => {
  process.env.RATE_LIMIT_CHAT = "1:60";
  __resetRateLimitsForTests();

  const first = await chatPost(ipReq("POST", { messages: [{ role: "user", content: "hi" }] }, token({ tenantId: "demo", userId: "cA", role: "demo" }), "5.5.5.5"));
  assert.equal(first.status, 200);
  await drain(first);

  const second = await chatPost(ipReq("POST", { messages: [{ role: "user", content: "hi" }] }, token({ tenantId: "demo", userId: "cB", role: "demo" }), "5.5.5.5"));
  assert.equal(second.status, 429, "different user, same IP → blocked by the per-IP limit");
});

test("POST /api/memory/image returns 400 (not 500) for a non-multipart body", async () => {
  const tok = token({ tenantId: "demo", userId: "img-user", role: "demo" });
  const request = new Request("http://localhost/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${tok}` },
    body: JSON.stringify({ not: "multipart" }),
  });
  assert.equal((await imagePost(request)).status, 400);
});

test("POST /api/memory/image enforces a per-USER limit, even from rotating IPs (L1)", async () => {
  process.env.RATE_LIMIT_MODEL = "1:60"; // per-user limit = 1
  process.env.RATE_LIMIT_MODEL_IP = "100:60"; // per-IP generous, so the user limit is what fires
  __resetRateLimitsForTests();
  const tok = token({ tenantId: "demo", userId: "img-rl-user", role: "demo" });

  const img = (ip: string) =>
    new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${tok}`, "x-real-ip": ip },
      body: JSON.stringify({ not: "multipart" }),
    });

  // First call passes the limiter (then 400 for the non-multipart body); the second is blocked
  // before the body is ever read, proving the limit sits right after requireSession.
  assert.equal((await imagePost(img("1.1.1.1"))).status, 400);
  const second = await imagePost(img("2.2.2.2")); // same user, fresh IP
  assert.equal(second.status, 429, "the per-user limit blocks even from a new IP");
  assert.ok(Number(second.headers.get("Retry-After")) > 0, "a Retry-After is set");
});

test("the per-user model budget is ONE shared limit across ask/propose/entries/PUT/image", async () => {
  // All five paid model routes key their per-user limit under the same "model" family, so a single
  // 20/min budget is shared across them — spending it on ask + propose exhausts it for entries/image.
  process.env.RATE_LIMIT_MODEL = "20:60"; // shared per-user budget = 20
  process.env.RATE_LIMIT_MODEL_IP = "1000:60"; // per-IP generous, so the per-user limit is what fires
  __resetRateLimitsForTests();
  freshBackend();

  const ip = "3.3.3.3";
  const tok = token({ tenantId: "demo", userId: "shared-budget-user", role: "demo" });

  // 10 ask + 10 propose from the one user = 20 hits, exactly the shared budget.
  for (let i = 0; i < 10; i++) {
    const r = await askPost(ipReq("POST", { question: "what is stored here?" }, tok, ip));
    assert.notEqual(r.status, 429, `ask #${i + 1} is within budget`);
    await drain(r);
  }
  for (let i = 0; i < 10; i++) {
    const r = await proposePost(ipReq("POST", { messages: [{ role: "user", content: "i like tea" }] }, tok, ip));
    assert.notEqual(r.status, 429, `propose #${i + 1} is within budget`);
    await drain(r);
  }

  // The 21st call — on a DIFFERENT route (entries) — is rejected: the budget is shared, not per-route.
  const entries = await entriesPost(ipReq("POST", { text: "one too many" }, tok, ip));
  assert.equal(entries.status, 429, "entries is blocked by the shared per-user model budget");
  // ...and image too, for the same reason.
  const image = await imagePost(ipReq("POST", { not: "multipart" }, tok, ip));
  assert.equal(image.status, 429, "image is blocked by the same shared budget");

  // Positive control: a different user has their own fresh 20/min budget.
  const other = token({ tenantId: "demo", userId: "other-user", role: "demo" });
  const otherAsk = await askPost(ipReq("POST", { question: "anything?" }, other, ip));
  assert.notEqual(otherAsk.status, 429, "a different user is not affected by the first user's budget");
  await drain(otherAsk);
});
