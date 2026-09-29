import type { AgentStatus, MemoryGraphConnection, MemoryGraphData } from "../lib/memory/graph/types";

export type LoadState =
  | { status: "loading" }
  | { status: "unconfigured"; missing: string[] }
  | { status: "error"; message: string }
  | { status: "ready"; data: MemoryGraphData; connection: MemoryGraphConnection; agent: AgentStatus };

export type ReadyState = Extract<LoadState, { status: "ready" }>;

async function fetchGraphState(): Promise<LoadState> {
  try {
    const response = await fetch("/api/memory/graph", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as
      | (Partial<MemoryGraphData> & {
          configured?: boolean;
          connection?: MemoryGraphConnection;
          missing?: string[];
          agent?: AgentStatus;
          error?: string;
        })
      | null;

    if (!response.ok) throw new Error(body?.error || "The memory graph could not be loaded.");
    if (!body || body.configured === false) return { status: "unconfigured", missing: body?.missing ?? [] };
    if (!Array.isArray(body.nodes) || !Array.isArray(body.links) || !body.stats) {
      throw new Error("The memory graph could not be loaded.");
    }

    return {
      status: "ready",
      data: body as MemoryGraphData,
      connection: body.connection ?? { kind: "remote", label: "Remote Neo4j" },
      agent: body.agent ?? { configured: false },
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The memory graph could not be loaded.",
    };
  }
}

/*
 * The memory tab and the full memory page show the same graph, and the database can be a network
 * hop away. Keeping the last result here lets the page open with what the tab already had, then
 * revalidate quietly, instead of starting from an empty canvas. Nothing here is ever populated on
 * the server, so server and first client renders always agree.
 */
let latest: ReadyState | null = null;
let inflight: Promise<LoadState> | null = null;

/** The most recent graph loaded in this browser session, if any. */
export function peekGraphState(): ReadyState | null {
  return latest;
}

/**
 * Load the graph. Callers that ask at the same moment share one request; pass `force` after a
 * write so the answer cannot come from a request that started before it.
 */
export function loadGraphState({ force = false }: { force?: boolean } = {}): Promise<LoadState> {
  if (inflight && !force) return inflight;

  const request: Promise<LoadState> = fetchGraphState()
    .then((next) => {
      if (next.status === "ready") latest = next;
      else if (next.status === "unconfigured") latest = null;
      return next;
    })
    .finally(() => {
      if (inflight === request) inflight = null;
    });

  inflight = request;
  return request;
}

/** Start loading on intent (hover, focus) so the graph is often there by the time it is wanted. */
export function warmGraphState() {
  if (!latest && !inflight) void loadGraphState();
}

/** True when a reload brought nothing new, so views can keep what they have and skip re-laying out. */
export function sameGraphState(a: LoadState, b: LoadState) {
  return (
    a.status === "ready" &&
    b.status === "ready" &&
    a.connection.label === b.connection.label &&
    a.connection.instance === b.connection.instance &&
    a.agent.configured === b.agent.configured &&
    JSON.stringify(a.data) === JSON.stringify(b.data)
  );
}
