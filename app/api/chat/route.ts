import type { ModelMessage } from "ai";
import { inspectAgentRuntime } from "@/lib/agent/config";
import { createMateoAgent } from "@/lib/agent/mateo";
import { RATE_LIMITS, checkRateLimit, clientIp, rateLimitResponse } from "@/lib/auth/rate-limit";
import { requireSession, type Session } from "@/lib/auth/session";
import { memoryBackend } from "@/lib/memory/graph/backend";
import { inspectMemoryGraph } from "@/lib/memory/graph/config";
import { formatMemoriesForPrompt, recallQueryFromMessages } from "@/lib/memory/graph/recall";
import { readScopeFor } from "@/lib/memory/graph/scope";
import { LEGACY_TENANT_ID } from "@/lib/memory/graph/types";
import { readDurableImage, readDurableMemory } from "@/lib/memory/store";

export const runtime = "nodejs";
export const maxDuration = 60;

type IncomingMessage = {
  role: "user" | "assistant";
  content: string;
};

const MAX_MESSAGES = 24;
const MAX_MESSAGE_LENGTH = 8_000;

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IncomingMessage>;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0 &&
    candidate.content.length <= MAX_MESSAGE_LENGTH
  );
}

type MemoryStore = "graph" | "file" | "file-fallback";

/** The fictional seed flat file belongs to the demo tenant; no other tenant may read it. */
async function readSeedFileFor(session: Session): Promise<string> {
  return session.tenantId === LEGACY_TENANT_ID ? await readDurableMemory() : "";
}

/**
 * Recall what is relevant to this conversation from the memory graph, scoped to the caller.
 * If the graph is not configured, fall back to the flat seed file (demo tenant only). If it is
 * configured but fails, degrade to that same fallback rather than break the conversation.
 */
async function loadDurableMemory(
  messages: IncomingMessage[],
  session: Session,
): Promise<{ text: string; store: MemoryStore }> {
  if (!inspectMemoryGraph().configured) {
    return { text: await readSeedFileFor(session), store: "file" };
  }

  try {
    const recalled = await memoryBackend().recallMemories(recallQueryFromMessages(messages), readScopeFor(session));
    return { text: formatMemoriesForPrompt(recalled), store: "graph" };
  } catch (error) {
    console.error("Memory recall failed; falling back to the flat file:", error);
    return { text: await readSeedFileFor(session), store: "file-fallback" };
  }
}

export async function GET(request: Request) {
  const session = requireSession(request);
  if (session instanceof Response) return session;

  const status = inspectAgentRuntime();

  if (!status.configured) {
    return Response.json({
      configured: false,
      provider: status.provider ?? null,
      missing: status.missing,
    });
  }

  return Response.json({
    configured: true,
    provider: status.provider,
    model: status.model,
    baseURL: status.baseURL,
  });
}

export async function POST(request: Request) {
  const session = requireSession(request);
  if (session instanceof Response) return session;

  // Per IP and per session user, so one abusive user can't drain the model budget and one busy
  // tenant can't crowd everyone sharing an egress IP.
  const perIp = checkRateLimit(`chat:ip:${clientIp(request)}`, RATE_LIMITS.chat(), "ip");
  if (!perIp.ok) return rateLimitResponse(perIp.retryAfterSeconds);
  const perUser = checkRateLimit(`chat:user:${session.userId}`, RATE_LIMITS.chat(), "user");
  if (!perUser.ok) return rateLimitResponse(perUser.retryAfterSeconds);

  const runtime = inspectAgentRuntime();
  if (!runtime.configured) {
    return Response.json(
      {
        error: "Mateo’s agent runtime is not configured.",
        missing: runtime.missing,
      },
      { status: 503 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const messages =
    payload && typeof payload === "object" && "messages" in payload
      ? (payload as { messages?: unknown }).messages
      : undefined;

  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES ||
    !messages.every(isIncomingMessage)
  ) {
    return Response.json(
      { error: `Send between 1 and ${MAX_MESSAGES} valid user or assistant messages.` },
      { status: 400 },
    );
  }

  const durableMemory = await loadDurableMemory(messages, session);
  const durableImage = await readDurableImage({ tenantId: session.tenantId, userId: session.userId });
  const agent = createMateoAgent(runtime.config, durableMemory.text);
  const conversation = messages.map(
    ({ role, content }): ModelMessage => ({ role, content: content.trim() }),
  );
  const contextMessages: ModelMessage[] = [];

  if (durableImage) {
    contextMessages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: "This is a user-provided durable reference image. Use it when relevant.",
        },
        {
          type: "file",
          data: durableImage,
          mediaType: "image/jpeg",
          filename: "memorysample-image.jpg",
        },
      ],
    });
  }

  const modelMessages: ModelMessage[] = [...contextMessages, ...conversation];
  const result = await agent.stream({
    messages: modelMessages,
    abortSignal: request.signal,
  });

  return result.toTextStreamResponse({
    headers: {
      "Cache-Control": "no-store",
      "X-Emori-Provider": runtime.provider,
      "X-Emori-Memory": durableMemory.store,
    },
  });
}
