import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { DELETE as deleteEntry } from "../app/api/memory/entries/[id]/route";
import { POST as createEntry } from "../app/api/memory/entries/route";
import { POST as ask } from "../app/api/memory/ask/route";
import { GET as readGraph } from "../app/api/memory/graph/route";
import { POST as propose } from "../app/api/memory/propose/route";
import { createSession, signSession } from "../lib/auth/session";
import { closeMemoryGraph } from "../lib/memory/graph/client";
import { inspectMemoryGraph } from "../lib/memory/graph/config";
import { deleteMemory, getMemoryGraph, listMemories } from "../lib/memory/graph/repository";
import { startMockModel } from "./helpers/mock-model";

// Real handlers, real Neo4j, mock model. Skips when no database is configured.
const skip = inspectMemoryGraph().configured ? false : "NEO4J_URI and NEO4J_PASSWORD are not set";

const run = randomUUID().replace(/-/g, "").slice(0, 8);
const TENANT = `itest-${run}`;
const USER = `leo-${run}`;
const SECRET = "integration-secret-0123456789-abcd";
const reads = { tenantId: TENANT, ownerIds: [USER] };
const writes = { tenantId: TENANT, ownerId: USER };

const PASSAGE = `In the spring my aunt Verelda${run} took me to Quenby${run} and I felt calm.`;
const WRITING = `Nothing much today.\n\n${PASSAGE}\n\nAnyway, what's for dinner?`;

const ENV_KEYS = ["AI_PROVIDER", "AI_MODEL", "OPENROUTER_API_KEY", "CRUSOE_API_KEY", "AI_BASE_URL"] as const;
const originalEnv: Record<string, string | undefined> = {};
let originalSecret: string | undefined;
let authToken = "";
const created: string[] = [];
let model: Awaited<ReturnType<typeof startMockModel>>;

const json = (body: unknown) =>
  new Request("http://localhost/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });

const authedGet = () => new Request("http://localhost/api", { headers: { authorization: `Bearer ${authToken}` } });
const authedDelete = () => new Request("http://localhost/api", { method: "DELETE", headers: { authorization: `Bearer ${authToken}` } });

function useMockModel() {
  process.env.AI_PROVIDER = "openrouter";
  process.env.AI_MODEL = "test-model";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.AI_BASE_URL = model.baseURL;
  delete process.env.CRUSOE_API_KEY;
}

before(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  originalSecret = process.env.EMORI_SESSION_SECRET;
  process.env.EMORI_SESSION_SECRET = SECRET;
  authToken = signSession(createSession({ tenantId: TENANT, userId: USER, role: "member", ttlSeconds: 3600 }), SECRET);
  if (skip) return;

  model = await startMockModel();
  useMockModel();
  model.reply((body) => {
    if (body.includes("memory scout")) {
      return JSON.stringify({
        proposals: [
          {
            quote: PASSAGE,
            why: "A spring outing with family.",
            entities: [
              { name: `Verelda${run}`, kind: "person" },
              { name: `Quenby${run}`, kind: "place" },
              { name: "calm", kind: "feeling" },
              { name: "Invented Harbour", kind: "place" },
            ],
            relations: [{ from: `Verelda${run}`, to: `Quenby${run}`, label: "took Leo to" }],
          },
          { quote: "A sentence the user never wrote.", why: "made up" },
        ],
      });
    }
    if (body.includes("answer questions about")) return "It comes down to a spring outing [1]. Not this [99].";
    return JSON.stringify({ entities: [{ name: `Verelda${run}`, kind: "person" }], relations: [] });
  });
});

after(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  if (originalSecret === undefined) delete process.env.EMORI_SESSION_SECRET;
  else process.env.EMORI_SESSION_SECRET = originalSecret;

  if (!skip) {
    for (const id of created) await deleteMemory(writes, id);
    await model.close();
  }
  await closeMemoryGraph();
});

test("the scout proposes verbatim quotes, drops invented ones, and writes nothing", { skip }, async () => {
  const before = (await listMemories(reads, { limit: 500 })).length;

  const response = await propose(
    json({
      messages: [
        { role: "user", content: WRITING },
        { role: "assistant", content: "Mateo says: once we sailed to Invented Harbour." },
      ],
    }),
  );
  const body = (await response.json()) as { proposals: Array<{ quote: string; entities: Array<{ name: string }> }>; model: string };

  assert.equal(response.status, 200);
  assert.equal(body.model, "test-model");
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].quote, PASSAGE);
  assert.deepEqual(
    body.proposals[0].entities.map((entity) => entity.name),
    [`Verelda${run}`, `Quenby${run}`, "calm"],
    "an entity that is not in the quote is dropped",
  );
  assert.equal((await listMemories(reads, { limit: 500 })).length, before, "proposing saves nothing");
});

test("the scout validates its input and needs a model", { skip }, async () => {
  assert.equal((await propose(json({}))).status, 400);
  assert.equal((await propose(json({ messages: [] }))).status, 400);
  assert.equal(
    (await propose(json({ messages: [{ role: "assistant", content: "only the assistant spoke" }] }))).status,
    400,
    "assistant-only input has nothing to scout",
  );

  for (const key of ENV_KEYS) delete process.env[key];
  try {
    const response = await propose(json({ messages: [{ role: "user", content: WRITING }] }));
    assert.equal(response.status, 503);
    assert.match(JSON.stringify(await response.json()), /AI_MODEL/);
  } finally {
    useMockModel();
  }
});

test("approving a proposal saves the quote with the scout's connections, re-validated", { skip }, async () => {
  const response = await createEntry(
    json({
      text: PASSAGE,
      via: "scout",
      extraction: {
        entities: [
          { name: `Verelda${run}`, kind: "person" },
          { name: `Quenby${run}`, kind: "place" },
          { name: "Made Up Place", kind: "place" },
        ],
        relations: [{ from: `Verelda${run}`, to: `Quenby${run}`, label: "took Leo to" }],
      },
    }),
  );
  const body = (await response.json()) as { memory: { id: string; extractor: string; text: string }; entities: number; relations: number };
  created.push(body.memory.id);

  assert.equal(response.status, 201);
  assert.equal(body.memory.text, PASSAGE);
  assert.equal(body.memory.extractor, "scout");
  assert.equal(body.entities, 2, "the invented entity was dropped on the server");
  assert.equal(body.relations, 1);

  const graph = await getMemoryGraph(reads);
  const names = graph.nodes.filter((node) => node.type === "entity").map((node) => (node.type === "entity" ? node.name : ""));
  assert.ok(names.includes(`Verelda${run}`) && names.includes(`Quenby${run}`));
  assert.ok(!names.includes("Made Up Place"));
});

test("connections are only honoured for a scout-approved passage", { skip }, async () => {
  const response = await createEntry(
    json({
      text: `Later, Verelda${run} laughed again.`,
      extraction: { entities: [{ name: "Injected", kind: "person" }], relations: [] },
    }),
  );
  const body = (await response.json()) as { memory: { id: string; extractor: string } };
  created.push(body.memory.id);

  assert.equal(response.status, 201);
  assert.equal(body.memory.extractor, "llm:test-model", "without via=scout the server runs its own extraction");
});

test("asking answers from memories, cites only real ones, and changes nothing", { skip }, async () => {
  const before = (await listMemories(reads, { limit: 500 })).length;

  const response = await ask(json({ question: "What is this about?" }));
  const body = (await response.json()) as {
    answer: string;
    cited: string[];
    evidence: Array<{ id: string }>;
    generated: boolean;
    model: string;
  };

  assert.equal(response.status, 200);
  assert.equal(body.generated, true);
  assert.equal(body.model, "test-model");
  assert.equal(body.answer, "It comes down to a spring outing [1]. Not this.");
  assert.equal(body.cited.length, 1);
  assert.ok(body.evidence.some((item) => item.id === body.cited[0]), "the citation points at real evidence");
  assert.equal((await listMemories(reads, { limit: 500 })).length, before, "answers are never stored");

  assert.equal((await ask(json({ question: "" }))).status, 400);
  assert.equal((await ask(json({ question: "q".repeat(501) }))).status, 400);
});

test("a failing model surfaces as a 502, not a crash", { skip }, async () => {
  model.fail();
  try {
    assert.equal((await ask(json({ question: "Anything?" }))).status, 502);
    assert.equal((await propose(json({ messages: [{ role: "user", content: WRITING }] }))).status, 502);
  } finally {
    model.reply("{}");
  }
});

test("the graph payload reports whether the agents are available", { skip }, async () => {
  const withModel = (await (await readGraph(authedGet())).json()) as { configured: boolean; agent: { configured: boolean; model?: string } };
  assert.deepEqual(withModel.agent, { configured: true, model: "test-model" });

  for (const key of ENV_KEYS) delete process.env[key];
  try {
    const withoutModel = (await (await readGraph(authedGet())).json()) as { agent: { configured: boolean } };
    assert.equal(withoutModel.agent.configured, false);
  } finally {
    useMockModel();
  }
});

test("approved memories can be erased through the route, once", { skip }, async () => {
  const id = created[0];
  const context = (value: string) => ({ params: Promise.resolve({ id: value }) });

  assert.equal((await deleteEntry(authedDelete(), context(id))).status, 200);
  assert.equal((await deleteEntry(authedDelete(), context(id))).status, 404);
});

test("another tenant's session cannot read these memories", { skip }, async () => {
  const otherToken = signSession(
    createSession({ tenantId: `other-${run}`, userId: USER, role: "member", ttlSeconds: 3600 }, Date.now()),
    SECRET,
  );
  const otherGet = new Request("http://localhost/api", { headers: { authorization: `Bearer ${otherToken}` } });
  const graph = (await (await readGraph(otherGet)).json()) as { stats: { memories: number } };
  assert.equal(graph.stats.memories, 0, "a different tenant sees none of this tenant's memories");
});
