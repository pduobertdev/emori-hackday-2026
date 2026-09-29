import { inspectAgentRuntime } from "../../agent/config";
import { saveMemory } from "./repository";
import { USER_OWNER_ID } from "./types";

/**
 * Save something Leo shared. Uses the configured chat model to find entities when there is one.
 * The owner is fixed server-side; the browser never chooses whose memory this is.
 *
 * `scoutExtraction` carries connections the memory scout already found for a passage Leo
 * approved. It is re-validated against the text like any model output, and no second model
 * call is made.
 */
export function saveUserMemory(input: { text: string; eventDate?: string; scoutExtraction?: unknown }) {
  if (input.scoutExtraction !== undefined) {
    return saveMemory({
      ownerId: USER_OWNER_ID,
      text: input.text,
      eventDate: input.eventDate,
      extraction: input.scoutExtraction,
      extractor: "scout",
    });
  }

  const agent = inspectAgentRuntime();

  return saveMemory({
    ownerId: USER_OWNER_ID,
    text: input.text,
    eventDate: input.eventDate,
    runtime: agent.configured ? agent.config : undefined,
  });
}
