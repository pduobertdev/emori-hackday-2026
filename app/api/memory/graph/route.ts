import { inspectAgentRuntime } from "@/lib/agent/config";
import { requireSession } from "@/lib/auth/session";
import { memoryBackend } from "@/lib/memory/graph/backend";
import { describeMemoryGraphConnection, inspectMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { readScopeFor } from "@/lib/memory/graph/scope";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = requireSession(request);
  if (session instanceof Response) return session;

  const status = inspectMemoryGraph();

  if (!status.configured) {
    return Response.json({ configured: false, missing: status.missing }, { headers: NO_STORE });
  }

  // Lets the page enable the scout and Q&A only when a chat model is available.
  const agent = inspectAgentRuntime();

  try {
    const graph = await memoryBackend().getMemoryGraph(readScopeFor(session));
    const connection = describeMemoryGraphConnection(status.config.uri);

    return Response.json(
      {
        configured: true,
        connection,
        agent: agent.configured ? { configured: true, model: agent.model } : { configured: false, missing: agent.missing },
        ...graph,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
