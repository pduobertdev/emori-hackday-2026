export const ENTITY_KINDS = ["person", "place", "event", "object", "feeling", "topic"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * Who a memory came from. AI-generated replies are deliberately not representable here:
 * there is no code path that can store them as memories.
 */
export type MemorySource = "user" | "mateo_story";

export const USER_OWNER_ID = "leo";
export const MATEO_OWNER_ID = "mateo";
export const OWNER_NAMES: Record<string, string> = {
  [USER_OWNER_ID]: "Leo",
  [MATEO_OWNER_ID]: "Mateo",
};
/** Whose memories a conversation may read. Mateo's curated stories are visible to Leo's sessions. */
export const READABLE_OWNER_IDS = [USER_OWNER_ID, MATEO_OWNER_ID];

export const MAX_MEMORY_LENGTH = 50_000;

/** The tenant a row created before tenants existed belongs to. Keeps live Aura data readable. */
export const LEGACY_TENANT_ID = "demo";

/**
 * Deterministic prefix for the curated fictional seed (set by the seed script). It is the ONLY
 * legacy content (rows with no tenantId) that stays readable: a legacy row is visible only when it
 * is in the demo tenant AND its id begins with this prefix. That keeps the hand-authored Leo/Mateo
 * seed visible while hiding anything a past public-demo visitor typed under the shared "leo" owner.
 */
export const SEED_ID_PREFIX = "seed-";

/** The stable id of a seed memory: `seed-<ownerId>-<index>`. */
export function seedMemoryId(ownerId: string, index: number): string {
  return `${SEED_ID_PREFIX}${ownerId}-${index}`;
}

/** Scope for reads: one tenant, a set of owners the caller may see. */
export type ReadScope = { tenantId: string; ownerIds: string[] };
/** Scope for writes and deletes: always exactly the caller's own tenant and owner. */
export type WriteScope = { tenantId: string; ownerId: string };

export function sourceForOwner(ownerId: string): MemorySource {
  return ownerId === MATEO_OWNER_ID ? "mateo_story" : "user";
}

export class MemoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryInputError";
  }
}

/** The model failed, timed out, or returned something unusable. Distinct from bad user input. */
export class ModelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelError";
  }
}

export type ExtractedEntity = { key: string; name: string; kind: EntityKind };
/** `from` and `to` are entity keys. */
export type ExtractedRelation = { from: string; to: string; label: string };
export type Extraction = {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  eventDate?: string;
  /** "heuristic", "seed", or "llm:<model>". */
  extractor: string;
};

export type MemoryRecord = {
  id: string;
  ownerId: string;
  source: MemorySource;
  text: string;
  createdAt: string;
  eventDate?: string;
  extraction: "pending" | "done";
  extractor?: string;
};

export type RecalledMemory = MemoryRecord & {
  reason: "match" | "related" | "recent";
  /** Entity names that connect a `related` memory to a matching one. */
  via?: string[];
};

export type GraphMemoryNode = MemoryRecord & { type: "memory" };
export type GraphEntityNode = {
  type: "entity";
  id: string;
  name: string;
  kind: EntityKind;
  mentions: number;
};
export type GraphNode = GraphMemoryNode | GraphEntityNode;
export type GraphLink = {
  source: string;
  target: string;
  type: "MENTIONS" | "RELATED_TO";
  label?: string;
  extractor?: string;
  /** For RELATED_TO: the memory that stated the relation. */
  memoryId?: string;
};
/** Whether a chat model is available for the scout and Q&A. Never includes keys. */
export type AgentStatus = { configured: true; model: string } | { configured: false; missing?: string[] };

export type MemoryGraphData = {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: { memories: number; entities: number; links: number };
};

export type MemoryGraphConnection = {
  kind: "aura" | "local" | "remote";
  label: string;
  instance?: string;
};
