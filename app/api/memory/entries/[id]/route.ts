import { inspectMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { deleteMemory } from "@/lib/memory/graph/repository";
import { USER_OWNER_ID } from "@/lib/memory/graph/types";

export const runtime = "nodejs";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!inspectMemoryGraph().configured) {
    return Response.json({ error: "The memory graph is not configured." }, { status: 503 });
  }

  const { id } = await context.params;

  try {
    // Only Leo's own memories can be erased from the browser; Mateo's stories are curated.
    const deleted = await deleteMemory(USER_OWNER_ID, id);

    if (!deleted) {
      return Response.json({ error: "That memory was not found." }, { status: 404 });
    }

    return Response.json({ deleted: true }, { headers: NO_STORE });
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
