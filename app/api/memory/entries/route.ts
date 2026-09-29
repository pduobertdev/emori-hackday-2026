import { inspectMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { saveUserMemory } from "@/lib/memory/graph/service";

export const runtime = "nodejs";
// Indexing a memory may call the chat model.
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!inspectMemoryGraph().configured) {
    return Response.json({ error: "The memory graph is not configured." }, { status: 503 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const body = payload && typeof payload === "object" ? (payload as { text?: unknown; eventDate?: unknown }) : {};

  if (typeof body.text !== "string") {
    return Response.json({ error: "Send a text string." }, { status: 400 });
  }
  if (body.eventDate !== undefined && typeof body.eventDate !== "string") {
    return Response.json({ error: "The event date must be a string." }, { status: 400 });
  }

  try {
    const saved = await saveUserMemory({ text: body.text, eventDate: body.eventDate });
    return Response.json(saved, { status: 201, headers: NO_STORE });
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
