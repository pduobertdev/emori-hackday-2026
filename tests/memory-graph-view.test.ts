import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdjacency,
  connectingEntityIds,
  shortestPath,
  sharedEntityIds,
} from "../lib/memory/graph/view";
import type { GraphLink, GraphNode } from "../lib/memory/graph/types";

const memory = (id: string, source: "user" | "mateo_story"): GraphNode => ({
  type: "memory",
  id,
  ownerId: source === "user" ? "leo" : "mateo",
  source,
  text: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  extraction: "done",
});
const entity = (id: string): GraphNode => ({ type: "entity", id, name: id, kind: "object", mentions: 1 });
const mention = (source: string, target: string): GraphLink => ({ source, target, type: "MENTIONS" });

// leo1 -- corolla -- story1 -- lisbon -- story2      leo2 -- fresno   (leo2/fresno is disconnected)
const nodes = [
  memory("leo1", "user"),
  memory("leo2", "user"),
  memory("story1", "mateo_story"),
  memory("story2", "mateo_story"),
  entity("corolla"),
  entity("lisbon"),
  entity("fresno"),
];
const links = [
  mention("leo1", "corolla"),
  mention("story1", "corolla"),
  mention("story1", "lisbon"),
  mention("story2", "lisbon"),
  mention("leo2", "fresno"),
];

test("adjacency is symmetric", () => {
  const adjacency = buildAdjacency(links);
  assert.ok(adjacency.get("leo1")?.has("corolla"));
  assert.ok(adjacency.get("corolla")?.has("leo1"));
});

test("shared entities are those both Leo and Mateo mention", () => {
  const shared = sharedEntityIds(nodes, buildAdjacency(links));
  assert.deepEqual([...shared], ["corolla"]);
});

test("shortestPath finds the shortest chain and reports disconnected nodes", () => {
  const adjacency = buildAdjacency(links);

  assert.deepEqual(shortestPath(adjacency, "leo1", "story2"), ["leo1", "corolla", "story1", "lisbon", "story2"]);
  assert.deepEqual(shortestPath(adjacency, "story2", "leo1"), ["story2", "lisbon", "story1", "corolla", "leo1"]);
  assert.deepEqual(shortestPath(adjacency, "leo1", "leo1"), ["leo1"]);
  assert.equal(shortestPath(adjacency, "leo1", "leo2"), null);
  assert.equal(shortestPath(adjacency, "leo1", "missing"), null);
});

test("connectingEntityIds names why a set of memories belongs together", () => {
  const adjacency = buildAdjacency(links);

  assert.deepEqual([...connectingEntityIds(["leo1", "story1"], adjacency, nodes)], ["corolla"]);
  assert.deepEqual([...connectingEntityIds(["leo1", "story2"], adjacency, nodes)], []);
  assert.deepEqual([...connectingEntityIds(["leo1"], adjacency, nodes)], []);
});
