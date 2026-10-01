import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { closeMemoryGraph, writeGraph } from "../lib/memory/graph/client";
import { inspectMemoryGraph } from "../lib/memory/graph/config";
import { getMemoryGraph, listMemories } from "../lib/memory/graph/repository";
import { LEGACY_TENANT_ID, seedMemoryId } from "../lib/memory/graph/types";

// Proves the M1 rule against a real database: rows with no tenantId (created before tenants
// existed) are readable ONLY when the tenant is demo AND the id is a curated seed id. Anything a
// past visitor typed under the shared owner (a non-seed legacy id) is no longer exposed.
const skip = inspectMemoryGraph().configured ? false : "NEO4J_URI and NEO4J_PASSWORD are not set";

const run = randomUUID().replace(/-/g, "").slice(0, 8);
const OWNER = `legacy-${run}`;
const SEED_ID = seedMemoryId(OWNER, 0); // seed-legacy-<run>-0
const VISITOR_ID = `visitor-note-${run}`; // not seed-prefixed

const demoScope = { tenantId: LEGACY_TENANT_ID, ownerIds: [OWNER] };
const memberScope = { tenantId: `other-${run}`, ownerIds: [OWNER] };

before(async () => {
  if (skip) return;
  // A legacy Person (no tenantId) with one seed memory and one visitor-typed memory, both legacy.
  await writeGraph((tx) =>
    tx.run(
      `CREATE (p:Person {id: $owner})
       CREATE (seed:Memory {id: $seedId, text: 'curated seed, legacy', source: 'user', createdAt: '2026-01-01T00:00:00.000Z', extraction: 'done'})
       CREATE (note:Memory {id: $noteId, text: 'something a visitor typed, legacy', source: 'user', createdAt: '2026-01-02T00:00:00.000Z', extraction: 'done'})
       CREATE (p)-[:SHARED]->(seed)
       CREATE (p)-[:SHARED]->(note)`,
      { owner: OWNER, seedId: SEED_ID, noteId: VISITOR_ID },
    ),
  );
});

after(async () => {
  if (!skip) {
    await writeGraph((tx) =>
      tx.run("MATCH (p:Person {id: $owner}) OPTIONAL MATCH (p)-[:SHARED]->(m:Memory) DETACH DELETE p, m", {
        owner: OWNER,
      }),
    );
  }
  await closeMemoryGraph();
});

test("a legacy seed row stays readable in the demo tenant; a legacy visitor-typed row does not", { skip }, async () => {
  const ids = (await listMemories(demoScope, { limit: 100 })).map((m) => m.id);
  assert.ok(ids.includes(SEED_ID), "the curated legacy seed is still visible");
  assert.ok(!ids.includes(VISITOR_ID), "a legacy non-seed row is no longer exposed");

  const graph = await getMemoryGraph(demoScope);
  const graphIds = graph.nodes.filter((n) => n.type === "memory").map((n) => n.id);
  assert.ok(graphIds.includes(SEED_ID) && !graphIds.includes(VISITOR_ID));
  assert.equal(graph.stats.memories, 1, "only the seed row is counted");
});

test("legacy rows are invisible outside the demo tenant, even the seed", { skip }, async () => {
  assert.equal((await listMemories(memberScope, { limit: 100 })).length, 0, "a member tenant sees no legacy rows");
});
