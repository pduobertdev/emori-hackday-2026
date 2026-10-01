# Emori — Mateo

Emori lets someone give a memory that another person can talk with. The giver records a story in their own words, reviews it, and approves what can be shared. The recipient opens it on a phone and asks questions. Emori answers from the recorded memory and says when a detail was not recorded; it does not pretend to be the storyteller. Mateo and Leo are fictional demo characters.

This Hack Day prototype uses a Next.js and React interface, Neo4j for the exact memory text and its connections, and a provider-neutral AI runtime for grounded answers when a model is configured. Voice transcription is optional. DuploCloud media analysis is planned, not deployed in this demo.

- [Open the live Emori demo](https://emori-hackday-2026.vercel.app/)
- [View the Hack Day presentation](https://docs.google.com/presentation/d/1uqjcIV5vcXak-V-jks1FKxcrtw8k2UFOTksA5vIFw-Y/edit?slide=id.emori_tech_status#slide=id.emori_tech_status)

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The prototype includes push-to-talk transcription, a text conversation view, and the “How Emori remembers” memory tab.

## Auth and tenant isolation

Every memory, chat and voice route requires a signed session; none of them act as a hardcoded
user any more. A session is a stateless token — `base64url(JSON).base64url(HMAC-SHA256)`, signed
with `EMORI_SESSION_SECRET` (≥32 chars) — carried either in the HttpOnly `emori_session` cookie
or an `Authorization: Bearer <token>` header. With no secret set, every protected route fails
closed with `401`. The auth check runs before any database or model check, so an unauthenticated
caller never learns whether those are configured.

Each token names a `tenantId`, a `userId`, and a role (`demo` or `member`). Memory and Person
nodes carry a `tenantId`, and every read filters by it; a Person is keyed by `(tenantId, id)`, so
the same id can never be shared across tenants. Writes and deletes always target the caller's own
tenant and user — never values from the request body or query — and deleting a memory that is not
yours returns `404` without revealing that it exists. Rows created before this change have no
`tenantId` and are read as the `demo` tenant (`coalesce(m.tenantId,'demo')`), so existing AuraDB
data keeps working with no migration.

- **Demo (public, no login).** When `EMORI_DEMO_ACCESS=on`, a page load mints a fresh anonymous
  visitor session in the `demo` tenant (role `demo`, 12h) via `proxy.ts`; `POST /api/session/demo`
  does the same on demand. A visitor reads the shared fictional seed (Leo + Mateo) plus their own
  writes, and can only add or delete their own memories — never the seed or another visitor's.
  Their memories still read as "Leo" in the UI (they role-play Leo). **The Vercel deployment must
  set `EMORI_SESSION_SECRET` and `EMORI_DEMO_ACCESS=on` for the public demo to keep working.**
- **Members (real tenants).** There is no signup UI. Mint a token for a real tenant/user with:

  ```bash
  npm run session:mint -- --tenant acme --user alice            # 30-day token
  npm run session:mint -- --tenant acme --user alice --ttl 3600 # custom TTL (seconds)
  ```

  A member reads only their own memories plus the tenant's curated storyteller.

Model and voice routes accept demo sessions (that is the demo). Rate limiting per session is a
sensible follow-up and is intentionally left out of this change.

## Agent runtime

Copy `.env.example` to `.env.local`, choose `openrouter` or `crusoe`, and add a current model ID and the matching API key. Secrets stay on the server.

The runtime can be used through the existing responsive interface, as a headless HTTP stream, or directly from the terminal:

```bash
# Mint a session token once (needs EMORI_SESSION_SECRET set), then pass it as a Bearer token.
TOKEN=$(npm run --silent session:mint -- --tenant acme --user alice)

# Health and configuration status
curl http://localhost:3000/api/chat -H "Authorization: Bearer $TOKEN"

# Headless HTTP request
curl -N http://localhost:3000/api/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello, Mateo."}]}'

# Direct process, no browser or Next.js server required (no HTTP route, so no token needed)
npm run agent -- "Hello, Mateo."
```

See [the runtime research report](docs/agent-runtime-report.md) for the provider and open-source framework evaluation.

## Voice transcription

Add `ELEVENLABS_API_KEY` to `.env.local` to enable the microphone. Tap once to start recording and again to stop. The recording is sent through the server-only `/api/voice/transcribe` route to ElevenLabs Scribe v2, then the transcript is placed in the composer for review before sending.

The prototype limits each recording to 60 seconds and 20 MB. Text-to-speech is not included yet.

## Memory graph (Neo4j)

New text memories require Neo4j AuraDB and never fall back to a local file. They are stored word for word as immutable nodes, indexed by the people, places, objects and feelings they mention, and recalled per message. Open [http://localhost:3000/memory](http://localhost:3000/memory) to see the graph.

**The memory tab.** The “How Emori remembers” button in the header opens a docked tab beside the conversation (a bottom sheet on phones). It shows a live preview of the graph, the three rules for what Emori keeps, the most recent memories, and a quick way to add one. Expanding it opens the full `/memory` page over the conversation, so an in-progress chat or recording is not lost, and Back collapses it. This is a parallel route with an intercepting route (`app/@panel/(.)memory`); a refresh or a shared `/memory` link gets the standalone page. Adding a new `@slot` folder needs a dev-server restart.

**Local database**

```bash
docker compose up -d
printf 'NEO4J_URI=bolt://localhost:7687\nNEO4J_USERNAME=neo4j\nNEO4J_PASSWORD=emori-local-dev\n' >> .env.local
npm run memory:seed   # loads the fictional demo set; add -- --reset to replace all Leo/Mateo memories
```

**Neo4j AuraDB**

1. Create an instance in the [Aura console](https://console.neo4j.io) and download the credentials file.
2. Put its values in `.env.local`: `NEO4J_URI` (the `neo4j+s://…databases.neo4j.io` address), `NEO4J_USERNAME`, `NEO4J_PASSWORD`, and `NEO4J_DATABASE` if your instance's database is not the default.
3. Run `npm run memory:seed`, then `npm run dev` and open `/memory`.

The first request creates three uniqueness constraints and a full-text index, so the Aura user needs write access. Everything was developed against Neo4j 5.26; it has not been run on Aura yet.

**Entity extraction.** When `AI_PROVIDER`/`AI_MODEL` are configured, the chat model finds the entities in each new memory. Anything it returns is validated: names must appear verbatim in the memory, and dates need an explicit year. Without a model, or if it fails, a simple word-matching fallback runs and the result is labelled as such.

**The graph page** (`/memory`) has three tabs:

- **Explore.** Click a memory or a connection to see it. Dashed halos mark *shared threads*, the things both Leo's memories and Mateo's stories mention. Pick "Trace a connection to…" to see the shortest path between two nodes. This needs no model.
- **Add.** Add a memory by hand, or paste something Leo wrote and let the **memory scout** propose passages worth keeping. Each proposal is an exact quote, and nothing is saved until you approve it.
- **Ask.** Ask a question of the saved memories. The answer cites the memories it used, lights them up on the graph, and is labelled AI-generated and never saved.

The scout and Ask need a chat model, set up the same way as Mateo's chat (`AI_PROVIDER`, `AI_MODEL` and its API key in `.env.local`). They are disabled with a note when none is configured. The rule they follow, that agents propose and people approve, is recorded in [ADR-0002](docs/adr/0002-agents-propose-people-approve.md). The storage decision is in [ADR-0001](docs/adr/0001-neo4j-memory-graph.md).

`npm test` also runs the Neo4j integration tests when `NEO4J_URI` is set. They use unique names and a mock model, and remove everything they add, so the demo data is left as it was.
