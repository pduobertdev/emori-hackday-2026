import { useMemo } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphNode, MemoryGraphData } from "../lib/memory/graph/types";

const WIDTH = 400;
const HEIGHT = 190;
const PADDING = 24;

type SimNode = SimulationNodeDatum & { id: string; radius: number };
type Placed = { node: GraphNode; x: number; y: number; radius: number };
type Segment = { key: string; x1: number; y1: number; x2: number; y2: number; related: boolean };

const radiusFor = (node: GraphNode) => (node.type === "memory" ? 5.5 : 2.2 + Math.min(node.mentions, 5) * 0.55);

/**
 * Lay the graph out once, synchronously, and fit it to the preview. It is the same force layout the
 * full page uses, just tighter, so the preview reads as a small copy of what the page will show.
 */
function layoutGraph(data: MemoryGraphData): { placed: Placed[]; segments: Segment[] } {
  if (data.nodes.length === 0) return { placed: [], segments: [] };

  const nodes: SimNode[] = data.nodes.map((node) => ({ id: node.id, radius: radiusFor(node) }));
  const links: Array<SimulationLinkDatum<SimNode>> = data.links.map((link) => ({ source: link.source, target: link.target }));

  const simulation = forceSimulation<SimNode>(nodes)
    .force("link", forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((node) => node.id).distance(26).strength(0.6))
    .force("charge", forceManyBody<SimNode>().strength((node) => (node.radius > 5 ? -80 : -26)))
    .force("collide", forceCollide<SimNode>().radius((node) => node.radius + 2.5))
    // Weaker pull on x than y so the cloud spreads wide, like the card it sits in.
    .force("x", forceX<SimNode>(0).strength(0.04))
    .force("y", forceY<SimNode>(0).strength(0.12))
    .stop();
  simulation.tick(nodes.length > 250 ? 90 : 240);

  // Bounds include each node's radius so dots at the edge are not clipped.
  const left = Math.min(...nodes.map((node) => (node.x ?? 0) - node.radius));
  const right = Math.max(...nodes.map((node) => (node.x ?? 0) + node.radius));
  const top = Math.min(...nodes.map((node) => (node.y ?? 0) - node.radius));
  const bottom = Math.max(...nodes.map((node) => (node.y ?? 0) + node.radius));
  // Never blow a tiny graph up into huge dots.
  const scale = Math.min(
    (WIDTH - PADDING * 2) / Math.max(right - left, 1),
    (HEIGHT - PADDING * 2) / Math.max(bottom - top, 1),
    1.5,
  );
  const offsetX = WIDTH / 2 - ((left + right) / 2) * scale;
  const offsetY = HEIGHT / 2 - ((top + bottom) / 2) * scale;

  const at = new Map(
    nodes.map((node) => [node.id, { x: (node.x ?? 0) * scale + offsetX, y: (node.y ?? 0) * scale + offsetY }]),
  );

  return {
    placed: data.nodes.flatMap((node) => {
      const point = at.get(node.id);
      return point ? [{ node, ...point, radius: radiusFor(node) * Math.min(scale, 1.15) }] : [];
    }),
    segments: data.links.flatMap((link, index) => {
      const from = at.get(link.source);
      const to = at.get(link.target);
      return from && to
        ? [{ key: `${link.source}-${link.target}-${index}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y, related: link.type === "RELATED_TO" }]
        : [];
    }),
  };
}

type MemoryPreviewProps = {
  data: MemoryGraphData;
  /** Memories that were just added; they ripple briefly. */
  freshIds?: ReadonlySet<string>;
};

/** A small, still picture of the memory graph. Decorative: the card around it carries the label. */
export function MemoryPreview({ data, freshIds }: MemoryPreviewProps) {
  const { placed, segments } = useMemo(() => layoutGraph(data), [data]);

  return (
    <svg className="memory-preview" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" focusable="false">
      <g>
        {segments.map((segment) => (
          <line
            key={segment.key}
            className={`memory-preview__link${segment.related ? " memory-preview__link--related" : ""}`}
            x1={segment.x1}
            y1={segment.y1}
            x2={segment.x2}
            y2={segment.y2}
          />
        ))}
      </g>
      <g>
        {placed
          .filter(({ node }) => node.type === "entity")
          .map(({ node, x, y, radius }) => (
            <circle
              key={node.id}
              className={`memory-preview__dot${node.type === "entity" ? ` graph-dot--${node.kind}` : ""}`}
              cx={x}
              cy={y}
              r={radius}
            />
          ))}
        {placed
          .filter(({ node }) => node.type === "memory")
          .map(({ node, x, y, radius }) => {
            const story = node.type === "memory" && node.source === "mateo_story";

            return (
              <g key={node.id} transform={`translate(${x} ${y})`}>
                {freshIds?.has(node.id) ? <circle className="graph-ripple" r={radius} /> : null}
                <circle className={story ? "memory-preview__story" : "memory-preview__ring"} r={radius} />
                {story ? (
                  <text className="memory-preview__glyph" textAnchor="middle" dominantBaseline="central">✣</text>
                ) : null}
              </g>
            );
          })}
      </g>
    </svg>
  );
}
