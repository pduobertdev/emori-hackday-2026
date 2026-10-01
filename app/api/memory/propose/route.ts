import { inspectAgentRuntime } from "@/lib/agent/config";
import { requireSession } from "@/lib/auth/session";
import { memoryBackend } from "@/lib/memory/graph/backend";
import { inspectMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { proposeMemories, userWords } from "@/lib/memory/graph/scout";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGES = 24;
const MAX_MESSAGE_LENGTH = 12_000;

/**
 * The memory scout. It only reads and proposes: nothing is written here. Anything that is
 * not the user's own words (assistant messages) is dropped before the model sees it.
 */
export async function POST(request: Request) {
  const session = requireSession(request);
  if (session instanceof Response) return session;

  if (!inspectMemoryGraph().configured) {
    return Response.json({ error: "The memory graph is not configured." }, { status: 503 });
  }

  const agent = inspectAgentRuntime();
  if (!agent.configured) {
    return Response.json(
      { error: "The memory scout needs a chat model.", missing: agent.missing },
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
    payload && typeof payload === "object" ? (payload as { messages?: unknown }).messages : undefined;

  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES ||
    !messages.every(
      (message) =>
        message &&
        typeof message === "object" &&
        typeof (message as { role?: unknown }).role === "string" &&
        typeof (message as { content?: unknown }).content === "string" &&
        (message as { content: string }).content.length <= MAX_MESSAGE_LENGTH,
    )
  ) {
    return Response.json(
      { error: `Send between 1 and ${MAX_MESSAGES} messages, each a role and text.` },
      { status: 400 },
    );
  }

  const typed = messages as Array<{ role: string; content: string }>;
  if (!userWords(typed)) {
    return Response.json({ error: "There is nothing written by the user to look at." }, { status: 400 });
  }

  try {
    // Dedupe only against the caller's own saved memories, in their own tenant.
    const existing = await memoryBackend().listMemories(
      { tenantId: session.tenantId, ownerIds: [session.userId] },
      { limit: 500 },
    );
    const proposals = await proposeMemories(typed, agent.config, existing);
    return Response.json({ proposals, model: agent.model }, { headers: NO_STORE });
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
