# Emori agent runtime report

_Researched 2026-09-29. Model catalogs and hosted-service behavior change quickly; links below are the source of truth._

## Recommendation

Use **Vercel AI SDK Core + `@ai-sdk/openai-compatible`** as Emori’s in-process agent runtime. Keep the runtime behind a small server-only adapter and expose it through a streamed Next.js route. This gives the current custom interface a real model connection without making the React design depend on a provider SDK, a hosted agent platform, or a browser.

Use **OpenRouter first for the hack-day build**. Its documentation explicitly standardizes streaming and tool calling across supported models, and its model catalog exposes a tool-support filter. Keep **Crusoe as a configuration-only switch** for text conversation and open-weight deployment. Crusoe documents an OpenAI-compatible Chat Completions endpoint and streaming, but its public documentation does not make the same catalog-wide tool-calling promise. Enable tools on Crusoe only after an integration test against the exact selected model or deployment.

The implementation in this repository follows that recommendation:

- `lib/agent/config.ts` selects OpenRouter or Crusoe from server-side environment variables.
- `lib/agent/mateo.ts` owns the reusable headless `ToolLoopAgent`.
- `app/api/chat/route.ts` exposes configuration status and a streamed, provider-neutral chat endpoint.
- `scripts/run-agent.ts` runs the same agent directly in a terminal without React or a Next.js server.
- `components/emori-experience.tsx` consumes the plain text stream while preserving the current custom design.

## What is verified

| Capability | OpenRouter | Crusoe | Consequence for Emori |
| --- | --- | --- | --- |
| OpenAI-compatible Chat Completions | Documented | Documented | One adapter works for both. |
| Token streaming | Documented | Documented, including SSE for self-serve deployments | The existing UI can render replies progressively. |
| Tool calling | Explicitly documented and normalized across tool-capable models | Not established in the public docs reviewed | Keep tools off by default for Crusoe until the chosen model passes a tool-call test. |
| Model discovery | `GET /api/v1/models` and web catalog | Current serverless catalog and `/v1/models` examples | Require `AI_MODEL`; do not bake a fast-aging model ID into source. |
| Provider failover | Built into OpenRouter routing | Not a serverless feature; dedicated deployments prioritize reserved capacity | OpenRouter is easier for the demo; Crusoe is attractive when control and reserved throughput matter. |

Primary provider documentation:

- [OpenRouter quickstart and OpenAI compatibility](https://openrouter.ai/docs/quickstart)
- [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [Crusoe Serverless Inference](https://docs.cloud.crusoe.ai/serverless-inference/index.html)
- [Crusoe self-serve deployment streaming example](https://docs.cloud.crusoe.ai/self-serve-deployments/quickstart/index.html)
- [Crusoe serverless rate limits](https://docs.cloud.crusoe.ai/serverless-inference/rate-limits/index.html)

## Open-source runtime options

| Option | License / hosting | Fit for this repository | Decision |
| --- | --- | --- | --- |
| [Vercel AI SDK](https://github.com/vercel/ai) | Apache-2.0; runs in-process in Node.js | Native TypeScript, stream primitives, `ToolLoopAgent`, provider abstraction, no second service | **Use now.** Smallest dependency and architecture change. |
| [Mastra](https://github.com/mastra-ai/mastra) | Core is Apache-2.0; enterprise directories use a separate license; self-hosted server is supported | Strong when Emori needs workflows, packaged memory, auth, Studio, and observability as a separate agent service | Revisit after the prototype. It duplicates a server/runtime layer that this Next.js app does not yet need. |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | MIT; self-hostable | Best for durable, explicit graphs, pause/resume, retries, checkpoints, and human approval flows | Not needed for a conversational loop. Choose it if the product becomes a multi-stage workflow rather than a chat experience. |
| [Hindsight](https://github.com/vectorize-io/hindsight) | Apache-2.0; Docker or bare-metal; PostgreSQL-backed | Useful optional memory service with temporal, semantic, and entity retrieval; AI SDK integration exists | Evaluate for semantic recall, not as the only record. The design promises word-for-word user memories, so raw immutable memory records still need their own store. |

Supporting documentation:

- [AI SDK OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers)
- [AI SDK ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)
- [Mastra self-hosted deployment models](https://mastra.ai/blog/deployment-models)
- [LangGraph durable state and checkpoints](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
- [Hindsight self-hosted installation and footprint](https://github.com/vectorize-io/hindsight/blob/main/skills/hindsight-docs/references/developer/installation.md)

## Memory architecture required by the design

The explainer in the current UI promises three distinct behaviors. They should remain separate in the backend:

1. **User-authored memory:** store Leo’s words exactly, with source, timestamps, consent state, and optional event date. This is the durable source of truth.
2. **Conversation context:** keep short-lived message history for the current conversation; discard it when the conversation ends unless the user explicitly promotes something to memory.
3. **Generated replies:** label and log them for observability if needed, but never feed them into the durable memory store as facts.

For a first production version, a small Postgres schema plus explicit retrieval is safer than letting the model autonomously decide what to remember. Hindsight can later add semantic and temporal retrieval over those records, but it should not replace the raw record or consent boundary.

## Deployment shape

```text
Responsive React UI
        │ streamed text
        ▼
Next.js /api/chat ──► Mateo ToolLoopAgent ──► OpenAI-compatible adapter
        │                                      ├─ OpenRouter
        │                                      └─ Crusoe
        └─ future memory boundary ──► Postgres (+ optional Hindsight)
```

This route is also the headless contract: any CLI, mobile app, test harness, or voice pipeline can call it without rendering the React page. API keys never cross the server boundary.

## Remaining production work

- Add authentication and derive the memory-bank/user ID server-side; never accept it blindly from the browser.
- Add request rate limits, token budgets, timeouts, structured logs, and provider error mapping (`429`, `503`, cancellation).
- Persist conversations only if product policy requires it; otherwise keep the current ephemeral behavior.
- Add a model capability smoke test for streaming and tool calls before enabling any tool in production.
- For voice, add separate speech-to-text and text-to-speech adapters. Neither OpenRouter nor the documented Crusoe text endpoint replaces the browser/audio transport layer.
- Add tool approval policy before any tool can write, send, delete, or expose private memory.
