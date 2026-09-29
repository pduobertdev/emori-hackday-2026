import { inspectMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { saveUserMemory } from "@/lib/memory/graph/service";
import { readDurableMemory, writeDurableMemory } from "@/lib/memory/store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  // With the graph enabled the flat file is no longer the store; the graph page lists memories.
  if (inspectMemoryGraph().configured) {
    return Response.json({ text: "", store: "neo4j" }, { headers: NO_STORE });
  }

  const text = await readDurableMemory();
  return Response.json({ text, store: "file" });
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

  // With the graph enabled, saving appends a new memory instead of overwriting one document.
  if (inspectMemoryGraph().configured) {
    try {
      const saved = await saveUserMemory({ text });
      return Response.json({ saved: true, store: "neo4j", ...saved }, { headers: NO_STORE });
    } catch (error) {
      return memoryGraphErrorResponse(error);
    }
  }

  try {
    await writeDurableMemory(text);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The memory could not be saved." },
      { status: 400 },
    );
  }

  return Response.json({ saved: true, store: "file" });
}
