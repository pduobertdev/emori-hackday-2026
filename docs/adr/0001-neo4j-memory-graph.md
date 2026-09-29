# ADR-0001: Neo4j as the store for Emori's durable memory

**Status:** Proposed. A working prototype is on `feat/neo4j-memory-graph`.
**Date:** 2026-09-29
**Deciders:** Emori hack-day team (Bryson, funkstop)
**Amends:** the storage suggestion in [agent-runtime-report.md](../agent-runtime-report.md), which proposed Postgres plus optional Hindsight.

## Context

Today Emori's memory is one flat file, `memorysample.txt`, plus one JPEG, both on local disk. Saving overwrites the file. The whole text is pasted into Mateo's system prompt on every turn. There is no user ID, no timestamp, and no consent record. Local-disk writes will not survive a serverless deploy.

The product makes promises that a flat file cannot keep. The "How Emori remembers" dialog and the runtime report say:

1. What Leo tells Mateo is saved **word for word**, with the event and day kept when mentioned, plus source, timestamps and consent.
2. There are three provenance classes: shared by Leo, Mateo's own stories, and AI-generated. **AI-generated replies never become memory.**
3. Nothing carries over between conversations. Emori "looks for what matters now", which means retrieval.
4. Mateo must never invent a memory, date, relationship or event.

Constraints: hack-day timeline; a TypeScript/Next.js stack; two model providers (OpenRouter and Crusoe) where tool calling is not verified on Crusoe; one user for now (Leo); content that is personal and possibly sensitive.

## Decision

Use **Neo4j as the single store** for memory records and the graph over them, with images staying out of the database. Concretely:

```cypher
(:Person {id})-[:SHARED]->(:Memory {id, text, source, createdAt, eventDate?, consent, extraction, extractor?})
(:Memory)-[:MENTIONS {derived, extractor}]->(:Entity {key, name, kind})   // person | place | event | object | feeling | topic
(:Entity)-[:RELATED_TO {memoryId, label, derived, extractor}]->(:Entity)
(:Memory)-[:SUPERSEDES]->(:Memory)                                          // edits append, never overwrite
```

Invariants:

- **The text is the record.** `Memory.text` is stored verbatim and never edited. An edit creates a new version linked by `SUPERSEDES`. Deleting a memory erases its whole version chain and any entity nothing else mentions.
- **The graph is an index, not a source of facts.** Entities and relations are derived. An LLM proposes them, and the result is validated: names must appear verbatim in the memory, relations must join two kept entities, and an event date needs its year stated in the text. Derived edges can be deleted and rebuilt without touching a memory. Each `RELATED_TO` edge records the memory that stated it.
- **Provenance is derived, not supplied.** `source` is computed from the owner (`leo` → `user`, `mateo` → `mateo_story`). Generated replies are not representable, and no code path from the chat route's output reaches a write.
- **Extraction never blocks or fails a save.** The record is written first. If indexing fails, it stays `extraction: "pending"` and the memory is still saved.
- **Recall is per message.** The chat route runs a full-text query over the last two user messages, adds memories that share an entity with a match, and falls back to the most recent memories when nothing matches. Text is injected verbatim into the existing `<durable-memory>` block with a provenance label. The route falls back to the flat file when Neo4j is unset or unreachable. This happens before the agent runs rather than as a model tool, so it works on both providers.
- **Nothing is hard-wired.** Neo4j is optional (`NEO4J_URI`, `NEO4J_PASSWORD`). Local development uses `docker-compose.yml`. AuraDB uses a `neo4j+s://` URI.

A `/memory` page renders the graph (`d3-force` + SVG), with the same ring / ✣ / solid-dot legend as the dialog, so the provenance model is visible.

## Options considered

### Option A: Keep the flat file

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | None |
| Scalability | Poor: whole file in every prompt, one document, overwritten on save |
| Team familiarity | High |

**Pros:** nothing to run. **Cons:** cannot represent versions, provenance or consent. There is no retrieval, so it does not scale past a few paragraphs. It is not deployable to serverless.

### Option B: Postgres for records, optionally Hindsight for recall (the runtime report's suggestion)

| Dimension | Assessment |
|---|---|
| Complexity | Medium; two systems if Hindsight is added |
| Cost | Low to medium |
| Scalability | Good |
| Team familiarity | High for Postgres |

**Pros:** relational records are a natural home for immutable rows and consent state. Hindsight brings semantic, temporal and entity retrieval. **Cons:** relationships between memories still need a separate mechanism. Hindsight adds a service, and the report itself notes that raw records still need their own store beside it. Relationship traversal in SQL is awkward.

### Option C: Neo4j as the single store (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium; one new service |
| Cost | Free locally; AuraDB Free for the demo (limits are inconsistently documented by Neo4j, so check the console) |
| Scalability | More than sufficient for a personal memory store |
| Team familiarity | Low; Cypher is new to the team |

**Pros:** records, relationships and full-text recall live in one ACID store. Entity traversal is a native query. The graph is directly visualizable, which shows provenance. Vector indexes are available when we want semantic recall. **Cons:** a new query language and a new service. Entities are LLM-derived and can be wrong. A graph adds no value at today's data size (see Consequences).

### Option D: A packaged memory layer (Graphiti/Zep on Neo4j, or Mem0 graph memory)

| Dimension | Assessment |
|---|---|
| Complexity | Medium to high; Graphiti is Python-first, and the TypeScript ports are third-party |
| Cost | Extra service or dependency |
| Scalability | Good |
| Team familiarity | Low |

**Pros:** entity extraction and temporal conflict resolution come built in. **Cons:** these tools decide what to remember and invalidate or rewrite facts when they conflict. That contradicts the promise of word-for-word, user-authored, consented memory. Adopting one means a Python sidecar or an unproven port.

## Trade-off analysis

The deciding question is who is allowed to decide what a memory says. Option D lets a system summarize, merge or invalidate memories, and a semantic layer such as Hindsight in Option B would need the same guardrails. Emori's promise is the opposite: the user's words are the record, and retrieval may only choose which records to show. Option C lets us keep raw records immutable and treat everything derived as disposable. The cost is building a thin layer ourselves and accepting Cypher as a new skill.

Option B is the safer engineering default and remains viable. If the team decides relationship traversal is not worth a new query language, Postgres with full-text search covers records, provenance and recall. What it gives up is the graph model and the visualization. The repository is behind one module (`lib/memory/graph/repository.ts`), so the choice is not a one-way door.

## Consequences

**Easier**

- Attributing a recalled memory to Leo or to Mateo's stories, and keeping the two straight in the prompt.
- Recalling memories that connect through a shared person, place or object, across Leo's memories and Mateo's stories.
- Showing users how their memories connect, and letting them erase one along with everything that only it supported.
- Adding semantic recall later with a vector index on `Memory`.

**Harder**

- Operating another service, and learning Cypher.
- Entities are shared across owners by design, so Leo's and Mateo's memories can link. **This does not isolate multiple users.** Multi-user needs owner-scoped entity keys or a database per tenant.
- Recall is lexical. It will miss paraphrases ("my sister" vs "Marisol") until embeddings are added.
- The heuristic fallback labels most names `topic` and can mislabel sentence openers. Mixing extractors can create duplicate entities (`topic:lisbon` and `place:lisbon`).

**Revisit**

- If the memory set stays at a few paragraphs, prompt stuffing was enough and this adds infrastructure without a visible payoff. The graph earns its place once there are many memories, or once cross-memory questions matter.
- The Aura Free tier's limits and any pause-on-inactivity behavior before demo day.

## Security and privacy notes

- The memory routes are **unauthenticated** and the owner is fixed server-side to `leo`. Add authentication and rate limits before any public deployment. `DELETE /api/memory/entries/[id]` can erase any of Leo's memories.
- Recalled text is injected as data inside `<durable-memory>`. Stored text cannot close that tag, and provenance labels tell the model whose words each entry is.
- Memories are sensitive personal content. Check Aura's encryption and retention settings before storing real memories there. Consent capture, retention limits and export are not built.
- Credentials live in `.env.local`. The local-dev password in `docker-compose.yml` is for local use only.

## Action items

Done in the prototype:

1. [x] Driver singleton, schema (three constraints, one full-text index with `standard-folding`), repository, recall, delete.
2. [x] Extraction with validation, model path, and heuristic fallback.
3. [x] Chat recall with fallback; `/memory` page; `POST /api/memory/entries`; `DELETE /api/memory/entries/[id]`; dialog integration.
4. [x] `docker-compose.yml`, seed script, README, unit and integration tests. The integration tests caught a cross-owner delete bug in the first draft; it is fixed and covered.

Open:

1. [ ] **Run against AuraDB** and confirm the schema statements and the `standard-folding` analyzer behave the same. Everything so far ran on Neo4j 5.26.
2. [ ] Add authentication, derive the owner ID server-side, and scope entities per owner.
3. [ ] Rate-limit and protect the write and delete routes.
4. [ ] Try a real model for extraction and review its output on real memories. Only a mock server has exercised that path.
5. [ ] Retry extraction for memories left `pending`.
6. [ ] Move the reference image to blob storage and record it as an `Asset` node with a hash.
7. [ ] Choose an embedding model and add a vector index if lexical recall proves too weak.
8. [ ] Design consent, retention and export.
9. [ ] Decide whether to import `memorysample.txt` into the graph.
