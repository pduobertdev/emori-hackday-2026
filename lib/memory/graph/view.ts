import type { GraphLink, GraphNode } from "./types";

/** Pure helpers over the graph payload. No database or server imports, so the browser can use them. */

export function buildAdjacency(links: GraphLink[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();

  for (const link of links) {
    if (!adjacency.has(link.source)) adjacency.set(link.source, new Set());
    if (!adjacency.has(link.target)) adjacency.set(link.target, new Set());
    adjacency.get(link.source)?.add(link.target);
    adjacency.get(link.target)?.add(link.source);
  }

  return adjacency;
}

/**
 * Entities that both Leo's memories and Mateo's stories mention. These are the threads that
 * let a conversation move from something Leo shared to a story Mateo can tell.
 */
export function sharedEntityIds(nodes: GraphNode[], adjacency: Map<string, Set<string>>): Set<string> {
  const sourceById = new Map<string, string>();
  for (const node of nodes) if (node.type === "memory") sourceById.set(node.id, node.source);

  const shared = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "entity") continue;

    const sources = new Set<string>();
    for (const neighbor of adjacency.get(node.id) ?? []) {
      const source = sourceById.get(neighbor);
      if (source) sources.add(source);
    }
    if (sources.has("user") && sources.has("mateo_story")) shared.add(node.id);
  }

  return shared;
}

/** Entities adjacent to at least two of the given memories: the reason those memories belong together. */
export function connectingEntityIds(
  memoryIds: string[],
  adjacency: Map<string, Set<string>>,
  nodes: GraphNode[],
): Set<string> {
  const wanted = new Set(memoryIds);
  const connecting = new Set<string>();

  for (const node of nodes) {
    if (node.type !== "entity") continue;

    let count = 0;
    for (const neighbor of adjacency.get(node.id) ?? []) if (wanted.has(neighbor)) count += 1;
    if (count >= 2) connecting.add(node.id);
  }

  return connecting;
}

/** Shortest chain of nodes between two ids, following links in either direction. */
export function shortestPath(adjacency: Map<string, Set<string>>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  if (!adjacency.has(from) || !adjacency.has(to)) return null;

  const previous = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];

    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);

      if (next === to) {
        const path = [to];
        while (path[0] !== from) path.unshift(previous.get(path[0]) as string);
        return path;
      }

      queue.push(next);
    }
  }

  return null;
}
