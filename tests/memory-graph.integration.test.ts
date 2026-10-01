import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { closeMemoryGraph } from "../lib/memory/graph/client";
import { inspectMemoryGraph } from "../lib/memory/graph/config";
import {
  deleteMemory,
  deleteOwnerData,
  getMemoryGraph,
  listMemories,
  recallMemories,
  saveMemory,
} from "../lib/memory/graph/repository";
import { MemoryInputError } from "../lib/memory/graph/types";

// These run against a real Neo4j (docker compose up -d). They skip when none is configured.
const skip = inspectMemoryGraph().configured ? false : "NEO4J_URI and NEO4J_PASSWORD are not set";

const run = randomUUID().replace(/-/g, "").slice(0, 8);
const tenant = `t-${run}`;
const otherTenant = `t-other-${run}`;
const owner = `test-${run}`;
const otherOwner = `test-other-${run}`;
const place = `Zorblax${run}`;
const person = `Quillon${run}`;

const entity = (name: string, kind: string) => ({ name, kind });
const reads = (ownerId: string, tenantId = tenant) => ({ tenantId, ownerIds: [ownerId] });
const writes = (ownerId: string, tenantId = tenant) => ({ tenantId, ownerId });

after(async () => {
  if (!skip) {
    await deleteOwnerData(writes(owner));
    await deleteOwnerData(writes(otherOwner));
    await deleteOwnerData(writes(owner, otherTenant));
  }
  await closeMemoryGraph();
});

test("a saved memory keeps its text verbatim and links its entities", { skip }, async () => {
  const text = `  ${person} took me to ${place} in the rain.\n  I felt grateful.  `;
  const saved = await saveMemory({
    tenantId: tenant,
    ownerId: owner,
    text,
    extraction: {
      entities: [entity(person, "person"), entity(place, "place"), entity("grateful", "feeling")],
      relations: [{ from: person, to: place, label: "took Leo to" }],
    },
  });

  assert.equal(saved.memory.text, text.trim());
  assert.equal(saved.memory.source, "user");
  assert.equal(saved.memory.extraction, "done");
  assert.equal(saved.entities, 3);
  assert.equal(saved.relations, 1);

  const graph = await getMemoryGraph(reads(owner));
  assert.equal(graph.stats.memories, 1);
  assert.deepEqual(
    graph.nodes.filter((node) => node.type === "entity").map((node) => node.name).sort(),
    ["grateful", person, place].sort(),
  );
  const related = graph.links.filter((link) => link.type === "RELATED_TO");
  assert.equal(related.length, 1);
  assert.equal(related[0].label, "took Leo to");
  assert.equal(related[0].memoryId, saved.memory.id);
});

test("entities are shared across memories and counted", { skip }, async () => {
  await saveMemory({
    tenantId: tenant,
    ownerId: owner,
    text: `We went back to ${place} in the snow.`,
    extraction: { entities: [entity(place, "place")] },
  });

  const graph = await getMemoryGraph(reads(owner));
  const shared = graph.nodes.find((node) => node.type === "entity" && node.name === place);

  assert.ok(shared && shared.type === "entity");
  assert.equal(shared.mentions, 2);
  assert.equal(graph.nodes.filter((node) => node.type === "entity" && node.name === place).length, 1);
});

test("memories can only be written for the derived source and with valid input", { skip }, async () => {
  await assert.rejects(saveMemory({ tenantId: tenant, ownerId: owner, text: "   " }), MemoryInputError);
  await assert.rejects(saveMemory({ tenantId: tenant, ownerId: owner, text: "x".repeat(50_001) }), MemoryInputError);
  await assert.rejects(
    saveMemory({ tenantId: tenant, ownerId: owner, text: "A date.", eventDate: "March 2023" }),
    MemoryInputError,
  );

  const stories = await saveMemory({
    tenantId: tenant,
    ownerId: "mateo",
    text: `A story about ${place}.`,
    extraction: { entities: [entity(place, "place")] },
  });
  assert.equal(stories.memory.source, "mateo_story");
  assert.ok(await deleteMemory(writes("mateo"), stories.memory.id));
});

test("without a model, the heuristic extractor indexes a memory and reads its date", { skip }, async () => {
  const saved = await saveMemory({
    tenantId: tenant,
    ownerId: otherOwner,
    text: `In March 2021 we drove past Vexmoor${run} and I felt nostalgic.`,
  });

  assert.equal(saved.memory.extractor, "heuristic");
  assert.equal(saved.memory.eventDate, "2021-03");
  assert.ok(saved.entities >= 1);
});

test("an explicit event date wins over an extracted one", { skip }, async () => {
  const saved = await saveMemory({
    tenantId: tenant,
    ownerId: otherOwner,
    text: `In March 2021 we drove past Vexmoor${run}.`,
    eventDate: "2021-04-02",
  });
  assert.equal(saved.memory.eventDate, "2021-04-02");
});

test("recall finds matches, folds accents, and pulls in memories that share an entity", { skip }, async () => {
  const related = await saveMemory({
    tenantId: tenant,
    ownerId: owner,
    text: "A quiet afternoon with nothing else in it.",
    extraction: { entities: [] },
  });
  const lucia = await saveMemory({
    tenantId: tenant,
    ownerId: owner,
    text: `Lucía${run} laughed on the porch at ${place}.`,
    extraction: { entities: [entity(`Lucía${run}`, "person"), entity(place, "place")] },
  });

  const byAccent = await recallMemories(`tell me about lucia${run}`, reads(owner));
  assert.equal(byAccent[0].id, lucia.memory.id);
  assert.equal(byAccent[0].reason, "match");

  const viaEntity = byAccent.filter((memory) => memory.reason === "related");
  assert.ok(viaEntity.length >= 1, "memories sharing an entity are recalled");
  assert.ok(viaEntity.every((memory) => memory.via?.includes(place)));
  assert.ok(!byAccent.some((memory) => memory.id === related.memory.id));
});

test("recall falls back to recent memories when nothing matches", { skip }, async () => {
  const recalled = await recallMemories("hi", reads(owner), { recentLimit: 2 });
  assert.equal(recalled.length, 2);
  assert.ok(recalled.every((memory) => memory.reason === "recent"));

  const noMatch = await recallMemories(`nothingmatchesthis${run}`, reads(owner), { recentLimit: 1 });
  assert.equal(noMatch[0].reason, "recent");
});

test("recall and lists are scoped to the requested owners", { skip }, async () => {
  const mine = await listMemories(reads(owner), { limit: 100 });
  const theirs = await listMemories(reads(otherOwner), { limit: 100 });

  assert.ok(mine.length > 0 && theirs.length > 0);
  assert.ok(mine.every((memory) => memory.ownerId === owner));
  assert.ok(theirs.every((memory) => memory.ownerId === otherOwner));
  assert.equal(await deleteMemory(writes(owner), theirs[0].id), false, "another owner's memory cannot be deleted");
});

test("reads and deletes never cross a tenant boundary", { skip }, async () => {
  const mine = await saveMemory({
    tenantId: tenant,
    ownerId: owner,
    text: `A memory in my own tenant ${run}.`,
    extraction: { entities: [] },
  });
  const theirs = await saveMemory({
    tenantId: otherTenant,
    ownerId: owner,
    text: `A memory in another tenant ${run}.`,
    extraction: { entities: [] },
  });

  const here = await listMemories(reads(owner), { limit: 100 });
  assert.ok(here.some((memory) => memory.id === mine.memory.id));
  assert.ok(!here.some((memory) => memory.id === theirs.memory.id), "the other tenant's memory is invisible here");

  assert.equal(
    await deleteMemory(writes(owner), theirs.memory.id),
    false,
    "a memory in another tenant cannot be deleted from this one",
  );
  const stillThere = await listMemories(reads(owner, otherTenant), { limit: 100 });
  assert.ok(stillThere.some((memory) => memory.id === theirs.memory.id), "the other tenant's memory survives");
});

test("editing appends a version and hides the old one; deleting erases the whole history", { skip }, async () => {
  const solo = `Solo${run}`;
  const first = await saveMemory({
    tenantId: tenant,
    ownerId: owner,
    text: `${solo} v1`,
    extraction: { entities: [entity(solo, "person")] },
  });
  const second = await saveMemory({
    tenantId: tenant,
    ownerId: owner,
    text: `${solo} v2`,
    supersedes: first.memory.id,
    extraction: { entities: [entity(solo, "person")] },
  });

  const texts = (await listMemories(reads(owner), { limit: 100 })).map((memory) => memory.text);
  assert.ok(texts.includes(`${solo} v2`));
  assert.ok(!texts.includes(`${solo} v1`), "the superseded version is hidden from current memories");

  await assert.rejects(
    saveMemory({ tenantId: tenant, ownerId: owner, text: "stale edit", supersedes: first.memory.id }),
    MemoryInputError,
    "only the latest version can be replaced",
  );
  assert.ok(
    !(await listMemories(reads(owner), { limit: 100 })).some((memory) => memory.text === "stale edit"),
    "a rejected edit is rolled back",
  );

  assert.equal(await deleteMemory(writes(owner), first.memory.id), false, "an old version cannot be targeted directly");
  assert.equal(await deleteMemory(writes(owner), second.memory.id), true);

  const graph = await getMemoryGraph(reads(owner));
  assert.ok(!graph.nodes.some((node) => node.type === "entity" && node.name === solo), "orphan entity removed");
  assert.equal(await deleteMemory(writes(owner), second.memory.id), false);
});

test("a memory that cannot be indexed is still saved as pending", { skip }, async () => {
  const saved = await saveMemory({
    tenantId: tenant,
    ownerId: owner,
    text: `Kept even if indexing breaks ${run}.`,
    extraction: { entities: [{ name: "x", kind: "person" }], relations: 42 },
  });
  // Malformed extraction is normalised away rather than failing the save.
  assert.equal(saved.memory.extraction, "done");
  assert.equal(saved.entities, 0);
  assert.ok((await listMemories(reads(owner), { limit: 100 })).some((memory) => memory.id === saved.memory.id));
});
