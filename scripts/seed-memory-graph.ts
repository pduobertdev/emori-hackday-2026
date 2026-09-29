import { loadEnvConfig } from "@next/env";
import { closeMemoryGraph } from "../lib/memory/graph/client";
import { inspectMemoryGraph } from "../lib/memory/graph/config";
import { deleteOwnerData, listMemories, saveMemory } from "../lib/memory/graph/repository";
import { SAMPLE_MEMORIES } from "../lib/memory/graph/sample";
import { MATEO_OWNER_ID, USER_OWNER_ID } from "../lib/memory/graph/types";

loadEnvConfig(process.cwd());

async function main() {
  const status = inspectMemoryGraph();

  if (!status.configured) {
    console.error(`The memory graph is not configured. Set ${status.missing.join(" and ")} in .env.local.`);
    console.error("Local database: docker compose up -d");
    process.exitCode = 1;
    return;
  }

  const reset = process.argv.includes("--reset");
  const existing = await listMemories({ limit: 1 });

  if (existing.length > 0 && !reset) {
    console.log("The graph already has memories. Nothing was changed.");
    console.log("Run `npm run memory:seed -- --reset` to replace ALL memories for Leo and Mateo with the demo set.");
    return;
  }

  if (reset) {
    await deleteOwnerData(USER_OWNER_ID);
    await deleteOwnerData(MATEO_OWNER_ID);
    console.log("Removed existing memories for Leo and Mateo.");
  }

  let entities = 0;
  for (const sample of SAMPLE_MEMORIES) {
    const result = await saveMemory({
      ownerId: sample.ownerId,
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
