import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { POST as chatPost } from "../app/api/chat/route";
import { createSession, signSession } from "../lib/auth/session";
import { closeMemoryGraph } from "../lib/memory/graph/client";
import { inspectMemoryGraph } from "../lib/memory/graph/config";
import { deleteOwnerData, recallMemories, saveMemory } from "../lib/memory/graph/repository";
import { startMockModel } from "./helpers/mock-model";

// Proves against a real Neo4j that recall is owner-scoped WITHIN a single tenant: two members of the
// same tenant cannot recall each other's memories, through either recall path (fulltext match AND
// the related-via-shared-entity path), nor through the chat route's recall. Removing the owner filter
// (`p.id IN $ownerIds` / `rp.id IN $ownerIds`) from either recall query makes these tests fail.
const skip = inspectMemoryGraph().configured ? false : "NEO4J_URI and NEO4J_PASSWORD are not set";

const SECRET = "recall-scope-secret-0123456789-abcdef";
const run = randomUUID().replace(/-/g, "").slice(0, 8);
const TENANT = `t-${run}`;
const OWNER_A = `a-${run}`;
const OWNER_B = `b-${run}`;

const ALPHA = `AlphaSecret${run}`; // appears only in owner A's text — exercises the fulltext match path
const BETA = `BetaPlace${run}`; // a place both A and B mention — exercises the related-via-entity path

const reads = (owner: string) => ({ tenantId: TENANT, ownerIds: [owner] });

let model: Awaited<ReturnType<typeof startMockModel>>;

before(async () => {
  if (skip) return;
  model = await startMockModel();
  model.reply("ok");
  process.env.EMORI_SESSION_SECRET = SECRET;
  process.env.AI_PROVIDER = "openrouter";
  process.env.AI_MODEL = "test-model";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.AI_BASE_URL = model.baseURL;
  delete process.env.CRUSOE_API_KEY;

  // Owner A: a private note with a unique word, plus a note sharing the BETA place with B.
  await saveMemory({
    tenantId: TENANT,
    ownerId: OWNER_A,
    text: `${ALPHA} is owner A's private note.`,
    extraction: { entities: [{ name: ALPHA, kind: "topic" }] },
  });
  await saveMemory({
    tenantId: TENANT,
    ownerId: OWNER_A,
    text: `Owner A also visited ${BETA}.`,
    extraction: { entities: [{ name: BETA, kind: "place" }] },
  });
  // Owner B: a note that mentions the same BETA place (so the related path has something to pull on).
  await saveMemory({
    tenantId: TENANT,
    ownerId: OWNER_B,
    text: `Owner B went to ${BETA} too.`,
    extraction: { entities: [{ name: BETA, kind: "place" }] },
  });
});

after(async () => {
  if (!skip) {
    await deleteOwnerData({ tenantId: TENANT, ownerId: OWNER_A });
    await deleteOwnerData({ tenantId: TENANT, ownerId: OWNER_B });
    await model.close();
    delete process.env.EMORI_SESSION_SECRET;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_BASE_URL;
  }
  await closeMemoryGraph();
});

test("the fulltext MATCH path never returns another owner's memory in the same tenant", { skip }, async () => {
  const forB = await recallMemories(ALPHA, reads(OWNER_B));
  assert.ok(!forB.some((m) => m.text.includes(ALPHA)), "owner B must not recall owner A's private note");

  const forA = await recallMemories(ALPHA, reads(OWNER_A));
  assert.ok(forA.some((m) => m.text.includes(ALPHA)), "owner A does recall their own note");
});

test("the RELATED (shared-entity) path never pulls in another owner's memory", { skip }, async () => {
  // B matches on BETA; the related path could reach A's BETA note through the shared Entity.
  const forB = await recallMemories(BETA, reads(OWNER_B));
  assert.ok(forB.some((m) => m.text.includes("Owner B")), "owner B recalls their own BETA note");
  assert.ok(
    !forB.some((m) => m.text.includes("Owner A")),
    "owner B must not recall owner A's BETA note, even via a shared entity",
  );

  const forA = await recallMemories(BETA, reads(OWNER_A));
  assert.ok(forA.some((m) => m.text.includes("Owner A")), "owner A does recall their own BETA note");
});

// A's memory TEXT — the phrases that only ever exist in owner A's notes. The bare ALPHA token
// can't be the probe here: B's own user message contains ALPHA, so it's always in the prompt.
const A_PRIVATE_NOTE = "is owner A's private note";
const A_BETA_NOTE = "Owner A also visited";

const chatRequest = (token: string) =>
  new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: "user", content: `Tell me about ${BETA} and ${ALPHA}.` }] }),
  });

test("the chat route's recall for owner B never leaks owner A's memory into the prompt", { skip }, async () => {
  const bToken = signSession(
    createSession({ tenantId: TENANT, userId: OWNER_B, role: "member", ttlSeconds: 3600 }),
    SECRET,
  );

  const response = await chatPost(chatRequest(bToken));
  assert.equal(response.status, 200);
  await response.text(); // drain the stream so the model request completes

  const sentToModel = model.lastBody();
  assert.ok(!sentToModel.includes(A_PRIVATE_NOTE), "owner A's private note text is never placed in B's prompt");
  assert.ok(!sentToModel.includes(A_BETA_NOTE), "owner A's BETA note text is never placed in B's prompt");
});

test("positive control: the same chat request as owner A DOES place A's note text in the prompt", { skip }, async () => {
  const aToken = signSession(
    createSession({ tenantId: TENANT, userId: OWNER_A, role: "member", ttlSeconds: 3600 }),
    SECRET,
  );

  const response = await chatPost(chatRequest(aToken));
  assert.equal(response.status, 200);
  await response.text();

  const sentToModel = model.lastBody();
  assert.ok(sentToModel.includes(A_PRIVATE_NOTE), "owner A's own private note text reaches the model for owner A");
});
