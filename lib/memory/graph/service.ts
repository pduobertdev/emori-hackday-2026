import { inspectAgentRuntime } from "../../agent/config";
import { saveMemory } from "./repository";
import { USER_OWNER_ID } from "./types";

/**
 * Save something Leo shared. Uses the configured chat model to find entities when there is one.
 * The owner is fixed server-side; the browser never chooses whose memory this is.
 */
export function saveUserMemory(input: { text: string; eventDate?: string }) {
  const agent = inspectAgentRuntime();

  return saveMemory({
    ownerId: USER_OWNER_ID,
    text: input.text,
    eventDate: input.eventDate,
    runtime: agent.configured ? agent.config : undefined,
  });
}
