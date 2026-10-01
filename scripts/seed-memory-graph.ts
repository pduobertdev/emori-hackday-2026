import { loadEnvConfig } from "@next/env";
import { closeMemoryGraph, writeGraph } from "../lib/memory/graph/client";
import { inspectMemoryGraph } from "../lib/memory/graph/config";
import { deleteOwnerData, listMemories, saveMemory } from "../lib/memory/graph/repository";
import { SAMPLE_MEMORIES } from "../lib/memory/graph/sample";
import { LEGACY_TENANT_ID, MATEO_OWNER_ID, USER_OWNER_ID, seedMemoryId } from "../lib/memory/graph/types";

loadEnvConfig(process.cwd());

// The fictional seed lives in the demo tenant, which is what public demo visitors read.
const TENANT = LEGACY_TENANT_ID;

async function main() {
  const status = inspectMemoryGraph();

  if (!status.configured) {
    console.error(`The memory graph is not configured. Set ${status.missing.join(" and ")} in .env.local.`);
    console.error("Local database: docker compose up -d");
    process.exitCode = 1;
    return;
  }

  const reset = process.argv.includes("--reset");
  const existing = await listMemories({ tenantId: TENANT, ownerIds: [USER_OWNER_ID, MATEO_OWNER_ID] }, { limit: 1 });

  if (existing.length > 0 && !reset) {
    console.log("The graph already has memories. Nothing was changed.");
    console.log("Run `npm run memory:seed -- --reset` to replace ALL memories for Leo and Mateo with the demo set.");
    return;
  }

  if (reset) {
    await deleteOwnerData({ tenantId: TENANT, ownerId: USER_OWNER_ID });
    await deleteOwnerData({ tenantId: TENANT, ownerId: MATEO_OWNER_ID });
    console.log("Removed existing memories for Leo and Mateo.");
  }

  // Reconcile any legacy Leo/Mateo Person created before tenants existed (null tenantId) into the
  // demo tenant, so saveMemory's MERGE (p:Person {id, tenantId}) matches it instead of creating a
  // second Person. Seed-only — the running app never writes these owner ids.
  await writeGraph((tx) =>
    tx.run("MATCH (p:Person) WHERE p.id IN $ids AND p.tenantId IS NULL SET p.tenantId = $tenant", {
      ids: [USER_OWNER_ID, MATEO_OWNER_ID],
      tenant: TENANT,
    }),
  );

  let entities = 0;
  for (const [index, sample] of SAMPLE_MEMORIES.entries()) {
    const result = await saveMemory({
      tenantId: TENANT,
      ownerId: sample.ownerId,
      id: seedMemoryId(sample.ownerId, index),
      text: sample.text,
      eventDate: sample.eventDate,
      extraction: { entities: sample.entities, relations: sample.relations ?? [] },
    });
    entities += result.entities;
  }

  console.log(`Seeded ${SAMPLE_MEMORIES.length} memories with ${entities} entity mentions.`);
  console.log("Open http://localhost:3000/memory (npm run dev).");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeMemoryGraph());
