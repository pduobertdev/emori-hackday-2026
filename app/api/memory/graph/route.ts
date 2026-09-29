import { describeMemoryGraphConnection, inspectMemoryGraph } from "@/lib/memory/graph/config";
import { NO_STORE, memoryGraphErrorResponse } from "@/lib/memory/graph/http";
import { getMemoryGraph } from "@/lib/memory/graph/repository";

export const runtime = "nodejs";

export async function GET() {
  const status = inspectMemoryGraph();

  if (!status.configured) {
    return Response.json({ configured: false, missing: status.missing }, { headers: NO_STORE });
  }

  try {
    const graph = await getMemoryGraph();
    const connection = describeMemoryGraphConnection(status.config.uri);
    return Response.json({ configured: true, connection, ...graph }, { headers: NO_STORE });
  } catch (error) {
    return memoryGraphErrorResponse(error);
  }
}
