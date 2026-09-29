# Emori — Mateo

A responsive, voice-first AI memory experience built with Next.js, React, and a provider-neutral AI SDK runtime.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The prototype includes push-to-talk transcription, a text conversation view, and the “How Emori remembers” explainer dialog.

## Agent runtime

Copy `.env.example` to `.env.local`, choose `openrouter` or `crusoe`, and add a current model ID and the matching API key. Secrets stay on the server.

The runtime can be used through the existing responsive interface, as a headless HTTP stream, or directly from the terminal:

```bash
# Health and configuration status
curl http://localhost:3000/api/chat

# Headless HTTP request
curl -N http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello, Mateo."}]}'

# Direct process, no browser or Next.js server required
npm run agent -- "Hello, Mateo."
```

See [the runtime research report](docs/agent-runtime-report.md) for the provider and open-source framework evaluation.

## Voice transcription

Add `ELEVENLABS_API_KEY` to `.env.local` to enable the microphone. Tap once to start recording and again to stop. The recording is sent through the server-only `/api/voice/transcribe` route to ElevenLabs Scribe v2, then the transcript is placed in the composer for review before sending.

The prototype limits each recording to 60 seconds and 20 MB. Text-to-speech is not included yet.

## Memory graph (Neo4j)

Optional. Without it, Emori keeps using the flat `memorysample.txt` file. With it, memories are stored word for word as immutable nodes, indexed by the people, places, objects and feelings they mention, and recalled per message instead of pasted in whole. Open [http://localhost:3000/memory](http://localhost:3000/memory) to see the graph.

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

`npm test` also runs the Neo4j integration tests when `NEO4J_URI` is set. They use throwaway owner IDs and leave the demo data alone.
