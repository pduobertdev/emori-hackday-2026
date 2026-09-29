import { MemoryInputError } from "./types";

const UNREACHABLE_CODES = new Set(["ServiceUnavailable", "SessionExpired", "ECONNREFUSED", "ENOTFOUND"]);

/** Map repository errors to JSON responses without leaking driver internals. */
export function memoryGraphErrorResponse(error: unknown): Response {
  if (error instanceof MemoryInputError) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  console.error("Memory graph request failed:", error);

  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const unreachable = UNREACHABLE_CODES.has(code) || code.startsWith("Neo.ClientError.Security");

  return Response.json(
    {
      error: unreachable
        ? "The memory graph database could not be reached."
        : "The memory graph request failed.",
    },
    { status: unreachable ? 503 : 500 },
  );
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;
