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
