import { inspectAgentRuntime } from "@/lib/agent/config";
import { askGraph, cleanQuestion } from "@/lib/memory/graph/ask";
import { inspectMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { memoriesForQuestion } from "@/lib/memory/graph/repository";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Ask a question of the saved memories. The answer is AI-generated and is returned only;
 * it is never written back to the graph.
 */
export async function POST(request: Request) {
  if (!inspectMemoryGraph().configured) {
    return Response.json({ error: "The memory graph is not configured." }, { status: 503 });
  }

  const agent = inspectAgentRuntime();
  if (!agent.configured) {
    return Response.json(
      { error: "Asking the graph needs a chat model.", missing: agent.missing },
      { status: 503 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const question = cleanQuestion(
    payload && typeof payload === "object" ? (payload as { question?: unknown }).question : undefined,
  );

  if (!question) {
    return Response.json({ error: "Send a question of up to 500 characters." }, { status: 400 });
  }

  try {
    const memories = await memoriesForQuestion(question);
    const result = await askGraph(question, memories, agent.config);
    return Response.json({ ...result, model: agent.model, generated: true }, { headers: NO_STORE });
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
