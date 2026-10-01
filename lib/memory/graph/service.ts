import { inspectAgentRuntime } from "../../agent/config";
import { memoryBackend } from "./backend";
import type { WriteScope } from "./types";

/**
 * Save something the caller shared. Uses the configured chat model to find entities when there
 * is one. The tenant and owner come from the caller's session via `scope`; the browser never
 * chooses whose memory this is or which tenant it lands in.
 *
 * `scoutExtraction` carries connections the memory scout already found for a passage the caller
 * approved. It is re-validated against the text like any model output, and no second model
 * call is made.
 */
export function saveUserMemory(
  scope: WriteScope,
  input: { text: string; eventDate?: string; scoutExtraction?: unknown },
) {
  const base = { tenantId: scope.tenantId, ownerId: scope.ownerId, text: input.text, eventDate: input.eventDate };

  if (input.scoutExtraction !== undefined) {
    return memoryBackend().saveMemory({ ...base, extraction: input.scoutExtraction, extractor: "scout" });
  }

  const agent = inspectAgentRuntime();
  return memoryBackend().saveMemory({ ...base, runtime: agent.configured ? agent.config : undefined });
}
