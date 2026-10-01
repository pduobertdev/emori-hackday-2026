import { type MemoryRecord, type RecalledMemory } from "./types";

const STOPWORDS = new Set([
  "about", "after", "again", "all", "also", "and", "any", "are", "because", "been", "before",
  "but", "can", "could", "did", "does", "for", "from", "had", "has", "have", "her", "him",
  "his", "how", "into", "its", "just", "like", "may", "more", "not", "now", "our", "out",
  "she", "some", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "those", "was", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your", "remember", "tell", "told", "hello", "hey",
]);

const MAX_QUERY_TERMS = 12;

/**
 * Turn free text into a safe Lucene query for the fulltext index: plain terms joined with OR,
 * with no user-supplied operators, quotes or wildcards. Returns undefined when nothing useful is left.
 */
export function buildFulltextQuery(text: string): string | undefined {
  const terms = new Set<string>();

  for (const term of text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (term.length < 3 || STOPWORDS.has(term)) continue;
    terms.add(term);
    if (terms.size >= MAX_QUERY_TERMS) break;
  }

  return terms.size > 0 ? [...terms].join(" OR ") : undefined;
}

/** The last two things the user said are the best signal for what to recall. */
export function recallQueryFromMessages(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((message) => message.role === "user")
    .slice(-2)
    .map((message) => message.content)
    .join("\n")
    .slice(-1_000);
}

/**
 * Who a memory came from, e.g. "Shared by Leo · about 2023-03" or "Mateo's own story".
 * Every user-shared memory reads as "Leo": in the demo each visitor role-plays Leo, so their
 * own id (a random visitor id) must never surface in the label.
 */
export function provenanceLabel(memory: MemoryRecord & { via?: string[] }): string {
  const when = memory.eventDate ? ` · about ${memory.eventDate}` : "";
  const origin = memory.source === "mateo_story" ? "Mateo's own story" : `Shared by Leo${when}`;
  const via = memory.via?.length ? ` · connected through ${memory.via.join(", ")}` : "";
  return `${origin}${via}`;
}

/**
 * Format recalled memories for the system prompt. Text is verbatim; only the wrapper tag is
 * neutralised so stored text cannot close the block it is embedded in.
 */
export function formatMemoriesForPrompt(memories: RecalledMemory[]): string {
  return memories
    .map((memory) => `[${provenanceLabel(memory)}]\n${memory.text.replace(/<\/?durable-memory>/gi, "").trim()}`)
    .join("\n\n");
}
