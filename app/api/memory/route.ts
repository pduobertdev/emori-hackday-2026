import { inspectMemoryGraph, isAuraMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { saveUserMemory } from "@/lib/memory/graph/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const graph = inspectMemoryGraph();
  if (!graph.configured || !isAuraMemoryGraph(graph.config)) {
    return Response.json(
      { error: "Neo4j AuraDB is not configured." },
      { status: 503, headers: NO_STORE },
    );
  }

  return Response.json({ text: "", store: "neo4j" }, { headers: NO_STORE });
}

export async function PUT(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const text =
    payload && typeof payload === "object" && "text" in payload
      ? (payload as { text?: unknown }).text
      : undefined;

  if (typeof text !== "string") {
    return Response.json({ error: "Send a text string." }, { status: 400 });
  }

  const graph = inspectMemoryGraph();
  if (!graph.configured || !isAuraMemoryGraph(graph.config)) {
    return Response.json(
      { error: "Neo4j AuraDB is not configured." },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    const saved = await saveUserMemory({ text });
    return Response.json({ saved: true, store: "neo4j", ...saved }, { headers: NO_STORE });
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
