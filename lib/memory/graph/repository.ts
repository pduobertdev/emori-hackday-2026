import { randomUUID } from "node:crypto";
import type { ManagedTransaction, Node } from "neo4j-driver";
import type { AgentRuntimeConfig } from "../../agent/config";
import { neo4j, readGraph, writeGraph } from "./client";
import { extractMemoryGraph, normalizeExtraction, parseEventDate } from "./extract";
import { buildFulltextQuery } from "./recall";
import {
  MAX_MEMORY_LENGTH,
  MemoryInputError,
  OWNER_NAMES,
  READABLE_OWNER_IDS,
  USER_OWNER_ID,
  sourceForOwner,
  type EntityKind,
  type Extraction,
  type GraphEntityNode,
  type GraphLink,
  type GraphNode,
  type MemoryGraphData,
  type MemoryRecord,
  type RecalledMemory,
} from "./types";

const NOT_SUPERSEDED = "NOT EXISTS { (:Memory)-[:SUPERSEDES]->(%) }";
const current = (alias: string) => NOT_SUPERSEDED.replace("%", alias);

function toMemory(node: Node, ownerId: string): MemoryRecord {
  const p = node.properties as Record<string, unknown>;

  return {
    id: String(p.id),
    ownerId,
    source: p.source === "mateo_story" ? "mateo_story" : "user",
    text: String(p.text),
    createdAt: String(p.createdAt),
    ...(typeof p.eventDate === "string" ? { eventDate: p.eventDate } : {}),
    extraction: p.extraction === "done" ? "done" : "pending",
    ...(typeof p.extractor === "string" ? { extractor: p.extractor } : {}),
  };
}

async function removeOrphanEntities(tx: ManagedTransaction) {
  await tx.run("MATCH (e:Entity) WHERE NOT EXISTS { (e)<-[:MENTIONS]-(:Memory) } DETACH DELETE e");
}

async function linkExtraction(tx: ManagedTransaction, memoryId: string, extraction: Extraction) {
  await tx.run("MATCH (:Memory {id: $memoryId})-[r:MENTIONS]->() DELETE r", { memoryId });
  await tx.run("MATCH ()-[r:RELATED_TO]->() WHERE r.memoryId = $memoryId DELETE r", { memoryId });

  await tx.run(
    `UNWIND $entities AS ent
     MATCH (m:Memory {id: $memoryId})
     MERGE (e:Entity {key: ent.key})
       ON CREATE SET e.name = ent.name, e.kind = ent.kind, e.createdAt = $now
     MERGE (m)-[r:MENTIONS]->(e)
     SET r.derived = true, r.extractor = $extractor`,
    { memoryId, entities: extraction.entities, extractor: extraction.extractor, now: new Date().toISOString() },
  );

  await tx.run(
    `UNWIND $relations AS rel
     MATCH (a:Entity {key: rel.from}), (b:Entity {key: rel.to})
     MERGE (a)-[r:RELATED_TO {memoryId: $memoryId, label: rel.label}]->(b)
     SET r.derived = true, r.extractor = $extractor`,
    { memoryId, relations: extraction.relations, extractor: extraction.extractor },
  );

  await tx.run(
    `MATCH (m:Memory {id: $memoryId})
     SET m.extraction = 'done', m.extractor = $extractor,
         m.eventDate = coalesce(m.eventDate, $eventDate)`,
    { memoryId, extractor: extraction.extractor, eventDate: extraction.eventDate ?? null },
  );

  await removeOrphanEntities(tx);
}

export type SaveMemoryInput = {
  ownerId?: string;
  text: string;
  eventDate?: string;
  /** Id of the current version this memory replaces. The old version is kept, never edited. */
  supersedes?: string;
  /** Model used to find entities. Without one, the heuristic extractor runs. */
  runtime?: AgentRuntimeConfig;
  /** Pre-computed extraction, e.g. hand-authored seed data. Validated like model output. */
  extraction?: unknown;
};

export type SaveMemoryResult = {
  memory: MemoryRecord;
  entities: number;
  relations: number;
};

/**
 * Store a memory verbatim, then index it. The record is written first and never blocks on
 * extraction: if indexing fails, the memory is still saved with extraction "pending".
 * The source is derived from the owner, so nothing model-generated can be saved as a memory.
 */
export async function saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult> {
  const ownerId = input.ownerId ?? USER_OWNER_ID;
  const text = input.text.trim();

  if (!text) throw new MemoryInputError("Memory text cannot be empty.");
  if (text.length > MAX_MEMORY_LENGTH) {
    throw new MemoryInputError(`Memory text cannot exceed ${MAX_MEMORY_LENGTH} characters.`);
  }

  let eventDate: string | undefined;
  if (input.eventDate !== undefined) {
    eventDate = parseEventDate(input.eventDate);
    if (!eventDate) throw new MemoryInputError("The event date must look like 2023, 2023-03 or 2023-03-14.");
  }

  const id = randomUUID();
  const source = sourceForOwner(ownerId);

  const created = await writeGraph(async (tx) => {
    const result = await tx.run(
      `MERGE (p:Person {id: $ownerId}) ON CREATE SET p.name = $ownerName
       CREATE (m:Memory {id: $id, text: $text, source: $source, createdAt: $createdAt,
                         consent: 'granted', extraction: 'pending'})
       CREATE (p)-[:SHARED]->(m)
       SET m.eventDate = $eventDate
       WITH p, m
       OPTIONAL MATCH (p)-[:SHARED]->(old:Memory {id: $supersedes})
         WHERE ${current("old")}
       FOREACH (_ IN CASE WHEN old IS NULL THEN [] ELSE [1] END | CREATE (m)-[:SUPERSEDES]->(old))
       RETURN m, old IS NOT NULL AS replaced`,
      {
        ownerId,
        ownerName: OWNER_NAMES[ownerId] ?? ownerId,
        id,
        text,
        source,
        createdAt: new Date().toISOString(),
        eventDate: eventDate ?? null,
        supersedes: input.supersedes ?? null,
      },
    );

    const record = result.records[0];
    if (input.supersedes && !record.get("replaced")) {
      throw new MemoryInputError("The memory to replace was not found or is not the latest version.");
    }
    return toMemory(record.get("m"), ownerId);
  });

  let memory = created;
  let extraction: Extraction = { entities: [], relations: [], extractor: "none" };

  try {
    extraction =
      input.extraction !== undefined
        ? normalizeExtraction(input.extraction, text, "seed")
        : await extractMemoryGraph(text, input.runtime);
    await writeGraph((tx) => linkExtraction(tx, id, extraction));
    memory = {
      ...created,
      extraction: "done",
      extractor: extraction.extractor,
      ...(created.eventDate || !extraction.eventDate ? {} : { eventDate: extraction.eventDate }),
    };
  } catch (error) {
    console.error("The memory was saved but could not be indexed:", error);
    extraction = { entities: [], relations: [], extractor: "none" };
  }

  return { memory, entities: extraction.entities.length, relations: extraction.relations.length };
}

export async function listMemories(options: { ownerIds?: string[]; limit?: number } = {}): Promise<MemoryRecord[]> {
  const { ownerIds = READABLE_OWNER_IDS, limit = 100 } = options;

  return readGraph(async (tx) => {
    const result = await tx.run(
      `MATCH (p:Person)-[:SHARED]->(m:Memory)
       WHERE p.id IN $ownerIds AND ${current("m")}
       RETURN m, p.id AS ownerId
       ORDER BY m.createdAt DESC
       LIMIT $limit`,
      { ownerIds, limit: neo4j.int(limit) },
    );
    return result.records.map((record) => toMemory(record.get("m"), record.get("ownerId")));
  });
}

/**
 * Find memories relevant to a message: fulltext matches first, then memories that share an
 * entity with a match. With no matches it falls back to the most recent memories so a bare
 * "hello" still carries some context.
 */
export async function recallMemories(
  query: string,
  options: { ownerIds?: string[]; limit?: number; relatedLimit?: number; recentLimit?: number } = {},
): Promise<RecalledMemory[]> {
  const { ownerIds = READABLE_OWNER_IDS, limit = 4, relatedLimit = 3, recentLimit = 3 } = options;
  const fulltext = buildFulltextQuery(query);

  if (fulltext) {
    const recalled = await readGraph(async (tx) => {
      const result = await tx.run(
        `CALL db.index.fulltext.queryNodes('memory_text', $query, {limit: $fetch}) YIELD node AS m, score
         MATCH (p:Person)-[:SHARED]->(m)
         WHERE p.id IN $ownerIds AND ${current("m")}
         WITH m, p, score ORDER BY score DESC LIMIT $limit
         OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)<-[:MENTIONS]-(r:Memory)<-[:SHARED]-(rp:Person)
         WHERE r <> m AND rp.id IN $ownerIds AND ${current("r")}
         WITH m, p, score, r, rp, collect(DISTINCT e.name) AS via
         RETURN m, p.id AS ownerId, score, r, rp.id AS relatedOwnerId, via
         ORDER BY score DESC`,
        { query: fulltext, ownerIds, fetch: neo4j.int(limit * 3), limit: neo4j.int(limit) },
      );

      const matches = new Map<string, RecalledMemory>();
      const related = new Map<string, RecalledMemory>();

      for (const record of result.records) {
        const match = toMemory(record.get("m"), record.get("ownerId"));
        if (!matches.has(match.id)) matches.set(match.id, { ...match, reason: "match" });

        const node = record.get("r");
        if (node) {
          const other = toMemory(node, record.get("relatedOwnerId"));
          const via = record.get("via") as string[];
          const seen = related.get(other.id);
          related.set(other.id, {
            ...other,
            reason: "related",
            via: [...new Set([...(seen?.via ?? []), ...via])],
          });
        }
      }

      const extra = [...related.values()].filter((memory) => !matches.has(memory.id)).slice(0, relatedLimit);
      return [...matches.values(), ...extra];
    });

    if (recalled.length > 0) return recalled;
  }

  const recent = await listMemories({ ownerIds, limit: recentLimit });
  return recent.map((memory) => ({ ...memory, reason: "recent" as const }));
}

export async function getMemoryGraph(options: { ownerIds?: string[] } = {}): Promise<MemoryGraphData> {
  const { ownerIds = READABLE_OWNER_IDS } = options;

  return readGraph(async (tx) => {
    const memoryRows = await tx.run(
      `MATCH (p:Person)-[:SHARED]->(m:Memory)
       WHERE p.id IN $ownerIds AND ${current("m")}
       RETURN m, p.id AS ownerId
       ORDER BY m.createdAt`,
      { ownerIds },
    );
    const mentionRows = await tx.run(
      `MATCH (p:Person)-[:SHARED]->(m:Memory)-[r:MENTIONS]->(e:Entity)
       WHERE p.id IN $ownerIds AND ${current("m")}
       RETURN m.id AS memoryId, e, r.extractor AS extractor`,
      { ownerIds },
    );
    const relationRows = await tx.run(
      `MATCH (a:Entity)-[r:RELATED_TO]->(b:Entity)
       MATCH (p:Person)-[:SHARED]->(m:Memory {id: r.memoryId})
       WHERE p.id IN $ownerIds AND ${current("m")}
       RETURN a.key AS source, b.key AS target, r.label AS label, r.memoryId AS memoryId, r.extractor AS extractor`,
      { ownerIds },
    );

    const nodes: GraphNode[] = memoryRows.records.map((record) => ({
      type: "memory",
      ...toMemory(record.get("m"), record.get("ownerId")),
    }));

    const links: GraphLink[] = [];
    const entities = new Map<string, GraphEntityNode>();

    for (const record of mentionRows.records) {
      const properties = (record.get("e") as Node).properties as Record<string, unknown>;
      const key = String(properties.key);
      const entity: GraphEntityNode = entities.get(key) ?? {
        type: "entity",
        id: key,
        name: String(properties.name),
        kind: properties.kind as EntityKind,
        mentions: 0,
      };

      entities.set(key, { ...entity, mentions: entity.mentions + 1 });
      links.push({
        source: record.get("memoryId"),
        target: key,
        type: "MENTIONS",
        ...(record.get("extractor") ? { extractor: record.get("extractor") } : {}),
      });
    }

    for (const record of relationRows.records) {
      if (!entities.has(record.get("source")) || !entities.has(record.get("target"))) continue;
      links.push({
        source: record.get("source"),
        target: record.get("target"),
        type: "RELATED_TO",
        label: record.get("label"),
        memoryId: record.get("memoryId"),
        ...(record.get("extractor") ? { extractor: record.get("extractor") } : {}),
      });
    }

    nodes.push(...entities.values());

    return {
      nodes,
      links,
      stats: { memories: memoryRows.records.length, entities: entities.size, links: links.length },
    };
  });
}

/**
 * Erase a memory, every earlier version of it, and any entity nothing else mentions.
 * Only the latest version can be targeted; returns false if it does not exist.
 */
export async function deleteMemory(ownerId: string, memoryId: string): Promise<boolean> {
  return writeGraph(async (tx) => {
    const found = await tx.run(
      `MATCH (:Person {id: $ownerId})-[:SHARED]->(m:Memory {id: $memoryId})
       WHERE ${current("m")}
       OPTIONAL MATCH (m)-[:SUPERSEDES*1..]->(old:Memory)
       RETURN m.id AS id, [x IN collect(DISTINCT old) | x.id] AS olds`,
      { ownerId, memoryId },
    );

    // Grouping by m.id matters: an aggregate with no grouping key returns one row even
    // when nothing matched, which would let any id (another owner's included) through.
    if (found.records.length === 0) return false;

    const ids = [memoryId, ...(found.records[0].get("olds") as string[])];
    await tx.run("MATCH ()-[r:RELATED_TO]->() WHERE r.memoryId IN $ids DELETE r", { ids });
    await tx.run("MATCH (m:Memory) WHERE m.id IN $ids DETACH DELETE m", { ids });
    await removeOrphanEntities(tx);
    return true;
  });
}

/** Remove everything an owner has stored. Used by the seed script and by tests. */
export async function deleteOwnerData(ownerId: string): Promise<void> {
  await writeGraph(async (tx) => {
    const result = await tx.run(
      "MATCH (:Person {id: $ownerId})-[:SHARED]->(m:Memory) RETURN collect(m.id) AS ids",
      { ownerId },
    );
    const ids = (result.records[0]?.get("ids") ?? []) as string[];

    await tx.run("MATCH ()-[r:RELATED_TO]->() WHERE r.memoryId IN $ids DELETE r", { ids });
    await tx.run("MATCH (m:Memory) WHERE m.id IN $ids DETACH DELETE m", { ids });
    await tx.run("MATCH (p:Person {id: $ownerId}) DETACH DELETE p", { ownerId });
    await removeOrphanEntities(tx);
  });
}
