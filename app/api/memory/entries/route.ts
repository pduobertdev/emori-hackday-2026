import { RATE_LIMITS, enforceIpAndUserLimit } from "@/lib/auth/rate-limit";
import { requireSession } from "@/lib/auth/session";
import { inspectMemoryGraph, isAuraMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { writeScopeFor } from "@/lib/memory/graph/scope";
import { saveUserMemory } from "@/lib/memory/graph/service";

export const runtime = "nodejs";
// Indexing a memory may call the chat model.
export const maxDuration = 60;

export async function POST(request: Request) {
  const session = requireSession(request);
  if (session instanceof Response) return session;

  // Indexing a memory may call the paid model — limit per IP and per user before any model/DB work.
  const limited = enforceIpAndUserLimit("model", session.userId, request, RATE_LIMITS.modelIp(), RATE_LIMITS.model());
  if (limited) return limited;

  const graph = inspectMemoryGraph();
  if (!graph.configured || !isAuraMemoryGraph(graph.config)) {
    return Response.json({ error: "Neo4j AuraDB is not configured." }, { status: 503 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const body =
    payload && typeof payload === "object"
      ? (payload as { text?: unknown; eventDate?: unknown; via?: unknown; extraction?: unknown })
      : {};

  if (typeof body.text !== "string") {
    return Response.json({ error: "Send a text string." }, { status: 400 });
  }
  if (body.eventDate !== undefined && typeof body.eventDate !== "string") {
    return Response.json({ error: "The event date must be a string." }, { status: 400 });
  }

  // Connections found by the scout are only honoured for a scout-approved passage.
  const scoutExtraction =
    body.via === "scout" && body.extraction && typeof body.extraction === "object"
      ? body.extraction
      : undefined;

  try {
    const saved = await saveUserMemory(writeScopeFor(session), {
      text: body.text,
      eventDate: body.eventDate,
      scoutExtraction,
    });
    return Response.json(saved, { status: 201, headers: NO_STORE });
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
