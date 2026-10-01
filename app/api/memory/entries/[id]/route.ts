import { requireSession } from "@/lib/auth/session";
import { memoryBackend } from "@/lib/memory/graph/backend";
import { inspectMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { writeScopeFor } from "@/lib/memory/graph/scope";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = requireSession(request);
  if (session instanceof Response) return session;

  if (!inspectMemoryGraph().configured) {
    return Response.json({ error: "The memory graph is not configured." }, { status: 503 });
  }

  const { id } = await context.params;

  try {
    // A memory can only be erased by the tenant and owner that created it; anything else — a
    // seed memory, another tenant's, another visitor's — is reported as not found.
    const deleted = await memoryBackend().deleteMemory(writeScopeFor(session), id);

    if (!deleted) {
      return Response.json({ error: "That memory was not found." }, { status: 404 });
    }

    return Response.json({ deleted: true }, { headers: NO_STORE });
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
