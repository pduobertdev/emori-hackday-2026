"use client";

import Link from "next/link";
import {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { CollapseIcon } from "./icons";
import { AddPanel, AskPanel } from "./memory-agent-panels";
import { type LoadState, loadGraphState, peekGraphState, sameGraphState } from "./memory-graph-store";
import { Brand, Eyebrow } from "./primitives";
import type { AskResult } from "../lib/memory/graph/ask";
import type {
  AgentStatus,
  EntityKind,
  GraphEntityNode,
  GraphLink,
  GraphMemoryNode,
  GraphNode,
  MemoryGraphData,
} from "../lib/memory/graph/types";
import { buildAdjacency, connectingEntityIds, shortestPath, sharedEntityIds } from "../lib/memory/graph/view";

type PanelTab = "explore" | "add" | "ask";
type Highlight = {
  ids: Set<string>;
  label: string;
  /** Small numbers drawn on nodes: citation numbers for an answer, step numbers for a path. */
  badges?: Map<string, string>;
};

type SimNode = SimulationNodeDatum & { id: string; radius: number };
type SimLink = SimulationLinkDatum<SimNode> & { link: GraphLink };
type Point = { x: number; y: number };
type View = { x: number; y: number; k: number };

type Drag =
  | { kind: "node"; node: SimNode; startX: number; startY: number; moved: boolean }
  | { kind: "pan"; startX: number; startY: number; origin: View; moved: boolean };

const KIND_LABEL: Record<EntityKind, string> = {
  person: "Person",
  place: "Place",
  object: "Object",
  feeling: "Feeling",
  event: "Event",
  topic: "Topic",
};
const KIND_ORDER: EntityKind[] = ["person", "place", "object", "feeling", "event", "topic"];
const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: "explore", label: "Explore" },
  { id: "add", label: "Add" },
  { id: "ask", label: "Ask" },
];

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD = 4;
const FRESH_MS = 4_500;

const isMemory = (node: GraphNode): node is GraphMemoryNode => node.type === "memory";
const isEntity = (node: GraphNode): node is GraphEntityNode => node.type === "entity";
const radiusFor = (node: GraphNode) => (isMemory(node) ? 14 : 5 + Math.min(node.mentions, 5) * 1.6);
const snippet = (text: string, length = 90) =>
  text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function sourceLabel(memory: GraphMemoryNode) {
  return memory.source === "mateo_story" ? "Mateo’s own story" : "Shared by Leo";
}

function describeExtractor(memory: GraphMemoryNode) {
  if (memory.extraction === "pending") return "These connections have not been found yet.";
  const extractor = memory.extractor ?? "";
  if (extractor === "seed") return "These connections were written by hand for the demo.";
  if (extractor === "scout") return "These connections were suggested by the memory scout, and you approved the passage.";
  if (extractor === "heuristic") return "These connections came from a simple word-matching pass, not a model.";
  if (extractor.startsWith("llm:")) return `These connections were found by ${extractor.slice(4)}.`;
  return "These connections are derived.";
}

function nodeName(node: GraphNode) {
  return isEntity(node) ? node.name : `${node.source === "mateo_story" ? "✣ " : ""}${snippet(node.text, 34)}`;
}

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type MemoryGraphViewProps = {
  /**
   * "page" is the standalone /memory route. "overlay" is the same view opened from the memory tab,
   * over the conversation, and swaps the way back to Mateo for a way back to the tab.
   */
  variant?: "page" | "overlay";
  onCollapse?: () => void;
};

const isPanelTab = (value: string | null): value is PanelTab => TABS.some((item) => item.id === value);

export function MemoryGraphView({ variant = "page", onCollapse }: MemoryGraphViewProps) {
  // Opened from the memory tab, the graph is usually already loaded: show it now, refresh behind it.
  const [state, setState] = useState<LoadState>(() => peekGraphState() ?? { status: "loading" });
  const [positions, setPositions] = useState<Map<string, Point>>(new Map());
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [tab, setTab] = useState<PanelTab>("explore");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [tracePath, setTracePath] = useState<string[] | null>(null);
  const [traceTarget, setTraceTarget] = useState("");
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef(0);
  const sizeRef = useRef(size);
  // Once the user pans or zooms, stop re-fitting the view underneath them.
  const viewTouchedRef = useRef(false);

  const data = state.status === "ready" ? state.data : undefined;
  const agent: AgentStatus = state.status === "ready" ? state.agent : { configured: false };

  const fitToView = useCallback(() => {
    const nodes = simNodesRef.current;
    if (nodes.length === 0) return;

    const xs = nodes.map((node) => node.x ?? 0);
    const ys = nodes.map((node) => node.y ?? 0);
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
    const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
    const padding = 90;
    const { w, h } = sizeRef.current;
    const k = clamp(Math.min(w / (maxX - minX + padding * 2), h / (maxY - minY + padding * 2)), MIN_ZOOM, 1.3);

    setView({ k, x: (-(minX + maxX) / 2) * k, y: (-(minY + maxY) / 2) * k });
  }, []);

  const refresh = useCallback(async () => {
    const next = await loadGraphState({ force: true });
    setState((current) => (sameGraphState(current, next) ? current : next));
  }, []);

  // When a reload brings new nodes, remember which so they can ripple in. This is derived from
  // the previous render's data, so it needs no ref (see React's "storing previous renders").
  const [seenData, setSeenData] = useState<MemoryGraphData | undefined>(undefined);
  if (data && data !== seenData) {
    setSeenData(data);

    if (seenData) {
      const before = new Set(seenData.nodes.map((node) => node.id));
      const added = data.nodes.map((node) => node.id).filter((id) => !before.has(id));
      if (added.length > 0) setFreshIds(new Set(added));
    }
  }

  useEffect(() => {
    let cancelled = false;

    // Links from the memory tab can name a memory to open, or a tool to start on.
    const applyDeepLink = (next: LoadState) => {
      if (cancelled || next.status !== "ready") return;

      const params = new URLSearchParams(window.location.search);
      const focus = params.get("focus");
      const wanted = params.get("tab");

      if (focus && next.data.nodes.some((node) => node.id === focus)) {
        setSelectedId(focus);
        setTab("explore");
      } else if (isPanelTab(wanted)) {
        setTab(wanted);
      }
    };

    const cached = peekGraphState();
    if (cached) queueMicrotask(() => applyDeepLink(cached));

    void loadGraphState().then((next) => {
      if (cancelled) return;
      setState((current) => (sameGraphState(current, next) ? current : next));
      if (!cached) applyDeepLink(next);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (freshIds.size === 0) return;
    const timer = setTimeout(() => setFreshIds(new Set()), FRESH_MS);
    return () => clearTimeout(timer);
  }, [freshIds]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = { w: entry.contentRect.width, h: entry.contentRect.height };
      sizeRef.current = next;
      setSize(next);
      if (!viewTouchedRef.current) fitToView();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitToView]);

  const publishPositions = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setPositions(new Map(simNodesRef.current.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }])));
    });
  }, []);

  // (Re)build the layout whenever the graph data changes, keeping positions of nodes that persist.
  useEffect(() => {
    if (!data) return;

    const previous = new Map(simNodesRef.current.map((node) => [node.id, node]));
    const nodes: SimNode[] = data.nodes.map((node) => {
      const prior = previous.get(node.id);
      return { id: node.id, radius: radiusFor(node), x: prior?.x, y: prior?.y, vx: prior?.vx, vy: prior?.vy };
    });
    const links: SimLink[] = data.links.map((link) => ({ source: link.source, target: link.target, link }));

    const simulation = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((node) => node.id)
          .distance((link) => (link.link.type === "RELATED_TO" ? 64 : 82))
          .strength(0.55),
      )
      .force("charge", forceManyBody<SimNode>().strength((node) => (node.radius > 12 ? -380 : -150)))
      .force("collide", forceCollide<SimNode>().radius((node) => node.radius + 13))
      .force("x", forceX<SimNode>(0).strength(0.1))
      .force("y", forceY<SimNode>(0).strength(0.1))
      .alphaDecay(0.025)
      .stop();

    // Settle most of the layout before first paint so the first fit is close to the final one.
    simulation.tick(reducedMotion ? 320 : 220);
    simNodesRef.current = nodes;
    simRef.current = simulation;
    setPositions(new Map(nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }])));

    const fitIfUntouched = () => {
      if (!viewTouchedRef.current) fitToView();
    };

    simulation.on("end", fitIfUntouched);
    queueMicrotask(fitIfUntouched);

    if (!reducedMotion) {
      simulation.on("tick", publishPositions).alpha(0.15).restart();
    }

    return () => {
      simulation.stop();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [data, publishPositions, reducedMotion, fitToView]);

  // Wheel zoom needs a non-passive listener so the page does not scroll underneath.
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      viewTouchedRef.current = true;
      const rect = element.getBoundingClientRect();
      const px = event.clientX - rect.left - size.w / 2;
      const py = event.clientY - rect.top - size.h / 2;

      setView((current) => {
        const k = clamp(current.k * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
        const wx = (px - current.x) / current.k;
        const wy = (py - current.y) / current.k;
        return { k, x: px - wx * k, y: py - wy * k };
      });
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [size.w, size.h, state.status]);

  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((node) => [node.id, node])), [data]);
  const adjacency = useMemo(() => buildAdjacency(data?.links ?? []), [data]);
  const sharedIds = useMemo(() => sharedEntityIds(data?.nodes ?? [], adjacency), [data, adjacency]);

  const memories = useMemo(() => (data?.nodes ?? []).filter(isMemory), [data]);
  const selected = selectedId ? nodeById.get(selectedId) : undefined;

  // What the canvas emphasises: hover wins, then an explicit highlight, then the selection.
  const emphasis = useMemo(() => {
    const around = (id: string) => new Set([id, ...(adjacency.get(id) ?? [])]);
    if (hoverId) return { ids: around(hoverId), center: hoverId };
    if (highlight) return { ids: highlight.ids, center: null };
    if (selected) return { ids: around(selected.id), center: selected.id };
    return null;
  }, [hoverId, highlight, selected, adjacency]);

  const toWorld = (clientX: number, clientY: number): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    return {
      x: (clientX - (rect?.left ?? 0) - size.w / 2 - view.x) / view.k,
      y: (clientY - (rect?.top ?? 0) - size.h / 2 - view.y) / view.k,
    };
  };

  const clearHighlight = () => {
    setHighlight(null);
    setTracePath(null);
    setTraceTarget("");
  };

  const select = (id: string | null, options: { keepHighlight?: boolean; openExplore?: boolean } = {}) => {
    setSelectedId(id);
    setConfirmingDelete(false);
    setNotice("");
    if (!options.keepHighlight) clearHighlight();
    if (options.openExplore || id === null) setTab("explore");
  };

  const onNodePointerDown = (event: ReactPointerEvent<SVGGElement>, id: string) => {
    const node = simNodesRef.current.find((candidate) => candidate.id === id);
    if (!node) return;

    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "node", node, startX: event.clientX, startY: event.clientY, moved: false };
    node.fx = node.x;
    node.fy = node.y;
    if (!reducedMotion) simRef.current?.alphaTarget(0.25).restart();
  };

  const onBackgroundPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = { kind: "pan", startX: event.clientX, startY: event.clientY, origin: view, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (distance > DRAG_THRESHOLD) drag.moved = true;
    if (!drag.moved) return;

    if (drag.kind === "pan") {
      viewTouchedRef.current = true;
      setView({
        ...drag.origin,
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      });
      return;
    }

    const point = toWorld(event.clientX, event.clientY);
    drag.node.fx = point.x;
    drag.node.fy = point.y;

    if (reducedMotion) {
      drag.node.x = point.x;
      drag.node.y = point.y;
      publishPositions();
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.kind === "node") {
      drag.node.fx = null;
      drag.node.fy = null;
      simRef.current?.alphaTarget(0);
      if (!drag.moved) select(drag.node.id, { openExplore: true });
    } else if (!drag.moved) {
      select(null);
    }
  };

  const onNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(id, { openExplore: true });
    }
  };

  const resetView = () => {
    viewTouchedRef.current = false;
    fitToView();
  };

  const zoomBy = (factor: number) => {
    viewTouchedRef.current = true;
    setView((current) => {
      const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = k / current.k;
      return { k, x: current.x * ratio, y: current.y * ratio };
    });
  };

  const eraseMemory = async (id: string) => {
    setBusy(true);
    setNotice("");

    try {
      const response = await fetch(`/api/memory/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "The memory could not be erased.");

      setSelectedId(null);
      setConfirmingDelete(false);
      clearHighlight();
      await refresh();
      setNotice("Memory erased, along with any connections only it supported.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory could not be erased.");
    } finally {
      setBusy(false);
    }
  };

  const onSaved = async (ids: string[], message: string) => {
    await refresh();
    select(ids[0] ?? null, { openExplore: true });
    setNotice(message);
  };

  const onAnswer = (result: AskResult) => {
    setSelectedId(null);
    setTracePath(null);
    if (result.cited.length === 0) {
      setHighlight(null);
      return;
    }

    const ids = new Set([...result.cited, ...connectingEntityIds(result.cited, adjacency, data?.nodes ?? [])]);
    const badges = new Map(result.evidence.filter((item) => result.cited.includes(item.id)).map((item) => [item.id, String(item.n)]));
    setHighlight({ ids, label: "Evidence for the answer", badges });
  };

  const showShared = () => {
    const ids = new Set(sharedIds);
    for (const id of sharedIds) for (const neighbor of adjacency.get(id) ?? []) ids.add(neighbor);
    setSelectedId(null);
    setTracePath(null);
    setHighlight({ ids, label: "Threads Leo and Mateo share" });
  };

  const trace = (from: string, to: string) => {
    setTraceTarget(to);
    if (!to) {
      clearHighlight();
      return;
    }

    const path = shortestPath(adjacency, from, to);
    setTracePath(path);
    setHighlight(
      path
        ? {
            ids: new Set(path),
            label: "Connection between two nodes",
            badges: new Map(path.map((id, index) => [id, String(index + 1)])),
          }
        : null,
    );
    if (!path) setNotice("Those two are not connected yet.");
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((item) => item.id === tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;

    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length].id;
    setTab(next);
    document.getElementById(`graph-tab-${next}`)?.focus();
  };

  const isEmpty = state.status === "ready" && memories.length === 0;

  const linkIsActive = (link: GraphLink) => {
    if (!emphasis) return false;
    if (emphasis.center) {
      return link.source === emphasis.center || link.target === emphasis.center || link.memoryId === emphasis.center;
    }
    return emphasis.ids.has(link.source) && emphasis.ids.has(link.target);
  };

  const nodeIsDim = (id: string) => emphasis !== null && !emphasis.ids.has(id);

  const renderNode = (node: GraphNode) => {
    const point = positions.get(node.id) ?? { x: 0, y: 0 };
    const dim = nodeIsDim(node.id);
    const isSelected = node.id === selectedId;
    const radius = radiusFor(node);
    const showLabel = isEntity(node) || emphasis?.center === node.id;
    const badge = highlight?.badges?.get(node.id);
    const label = isEntity(node) ? node.name : snippet(node.text, 48);
    const shared = isEntity(node) && sharedIds.has(node.id);
    const aria = isEntity(node)
      ? `${KIND_LABEL[node.kind]}: ${node.name}, in ${node.mentions} ${node.mentions === 1 ? "memory" : "memories"}${
          shared ? ", shared by Leo and Mateo" : ""
        }`
      : `${sourceLabel(node)}: ${snippet(node.text, 70)}`;

    return (
      <g
        key={node.id}
        className={`graph-node${dim ? " is-dim" : ""}${isSelected ? " is-selected" : ""}`}
        transform={`translate(${point.x} ${point.y})`}
        role="button"
        tabIndex={0}
        aria-label={aria}
        aria-pressed={isSelected}
        onPointerDown={(event) => onNodePointerDown(event, node.id)}
        onPointerEnter={() => setHoverId(node.id)}
        onPointerLeave={() => setHoverId((current) => (current === node.id ? null : current))}
        onFocus={() => setHoverId(node.id)}
        onBlur={() => setHoverId((current) => (current === node.id ? null : current))}
        onKeyDown={(event) => onNodeKeyDown(event, node.id)}
      >
        {freshIds.has(node.id) ? <circle className="graph-ripple" r={radius} /> : null}
        {shared ? <circle className="graph-halo" r={radius + 5} /> : null}
        {isEntity(node) ? (
          <circle className={`graph-dot graph-dot--${node.kind}`} r={radius} />
        ) : node.source === "mateo_story" ? (
          <>
            <circle className="graph-story" r={radius} />
            <text className="graph-glyph" textAnchor="middle" dominantBaseline="central" aria-hidden="true">
              ✣
            </text>
          </>
        ) : (
          <circle className="graph-ring" r={radius} />
        )}
        {badge ? (
          <g className="graph-badge" transform={`translate(${radius * 0.8} ${-radius * 0.8})`} aria-hidden="true">
            <circle r="8" />
            <text textAnchor="middle" dominantBaseline="central">{badge}</text>
          </g>
        ) : null}
        {showLabel ? (
          <text
            className={`graph-label${isMemory(node) ? " graph-label--memory" : ""}`}
            y={radius + (shared ? 20 : 15)}
            textAnchor="middle"
            aria-hidden="true"
          >
            {label}
          </text>
        ) : null}
      </g>
    );
  };

  const entityMemories = (entity: GraphEntityNode) =>
    memories.filter((memory) => adjacency.get(memory.id)?.has(entity.id));

  const relationsOf = (entity: GraphEntityNode) =>
    (data?.links ?? []).filter(
      (link) => link.type === "RELATED_TO" && (link.source === entity.id || link.target === entity.id),
    );

  const sharedEntities = [...sharedIds]
    .map((id) => nodeById.get(id))
    .filter((node): node is GraphEntityNode => !!node && isEntity(node))
    .sort((a, b) => b.mentions - a.mentions);

  const traceOptions = (data?.nodes ?? []).filter((node) => node.id !== selected?.id);

  const memoryListItem = (memory: GraphMemoryNode) => (
    <li key={memory.id}>
      <button type="button" onClick={() => select(memory.id, { openExplore: true })}>
        <span className="graph-list__source">{memory.source === "mateo_story" ? "✣ Mateo’s story" : "Leo"}</span>
        {snippet(memory.text, 110)}
      </button>
    </li>
  );

  const exploreDetail = () => {
    if (selected && isMemory(selected)) {
      return (
        <section className="graph-detail" aria-label="Selected memory">
          <p className={`graph-chip${selected.source === "mateo_story" ? " graph-chip--story" : ""}`}>
            {selected.source === "mateo_story" ? "✣ " : ""}
            {sourceLabel(selected)}
          </p>
          <blockquote>{selected.text}</blockquote>
          <p className="graph-meta">
            Saved {formatDate(selected.createdAt)}
            {selected.eventDate ? ` · about ${selected.eventDate}` : ""}
          </p>

          <h2>Connected through</h2>
          {(() => {
            const entities = [...(adjacency.get(selected.id) ?? [])]
              .map((id) => nodeById.get(id))
              .filter((node): node is GraphEntityNode => !!node && isEntity(node));

            return entities.length ? (
              <ul className="graph-chips">
                {entities.map((entity) => (
                  <li key={entity.id}>
                    <button type="button" onClick={() => select(entity.id, { openExplore: true })}>
                      <i className={`graph-swatch graph-swatch--${entity.kind}`} aria-hidden="true" />
                      {entity.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="graph-note">Nothing found yet.</p>
            );
          })()}
          <p className="graph-note">{describeExtractor(selected)}</p>

          {selected.source === "user" ? (
            confirmingDelete ? (
              <div className="graph-confirm" role="group" aria-label="Confirm erase">
                <p>Erase this memory permanently?</p>
                <button className="graph-button graph-button--danger" type="button" disabled={busy} onClick={() => void eraseMemory(selected.id)}>
                  Yes, erase it
                </button>
                <button className="graph-button graph-button--quiet" type="button" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </button>
              </div>
            ) : (
              <button className="graph-button graph-button--quiet" type="button" onClick={() => setConfirmingDelete(true)}>
                Erase memory
              </button>
            )
          ) : null}
        </section>
      );
    }

    if (selected && isEntity(selected)) {
      const relations = relationsOf(selected);

      return (
        <section className="graph-detail" aria-label="Selected connection">
          <p className="graph-chip">
            <i className={`graph-swatch graph-swatch--${selected.kind}`} aria-hidden="true" />
            {KIND_LABEL[selected.kind]} · derived
            {sharedIds.has(selected.id) ? " · shared" : ""}
          </p>
          <h2 className="graph-entity-name">{selected.name}</h2>
          <p className="graph-meta">
            In {selected.mentions} {selected.mentions === 1 ? "memory" : "memories"}
            {sharedIds.has(selected.id) ? ", from both Leo and Mateo" : ""}
          </p>

          {relations.length ? (
            <ul className="graph-relations">
              {relations.map((link, index) => {
                const from = nodeById.get(link.source);
                const to = nodeById.get(link.target);
                return (
                  <li key={`${link.source}-${link.target}-${index}`}>
                    <button
                      type="button"
                      onClick={() => select(link.source === selected.id ? link.target : link.source, { openExplore: true })}
                    >
                      {from && isEntity(from) ? from.name : ""} — {link.label} → {to && isEntity(to) ? to.name : ""}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <h2>Mentioned in</h2>
          <ul className="graph-list">{entityMemories(selected).map(memoryListItem)}</ul>
        </section>
      );
    }

    return (
      <>
        {sharedEntities.length ? (
          <section className="graph-detail" aria-label="Shared threads">
            <h2>Shared threads</h2>
            <p className="graph-note">Things both Leo and Mateo talk about. They are how a conversation can move from something Leo shared to a story Mateo can tell.</p>
            <ul className="graph-chips">
              {sharedEntities.map((entity) => (
                <li key={entity.id}>
                  <button type="button" onClick={() => select(entity.id, { openExplore: true })}>
                    <i className={`graph-swatch graph-swatch--${entity.kind}`} aria-hidden="true" />
                    {entity.name}
                  </button>
                </li>
              ))}
            </ul>
            <button className="graph-button graph-button--quiet" type="button" onClick={showShared}>
              Highlight on the graph
            </button>
          </section>
        ) : null}

        {memories.length > 0 ? (
          <section className="graph-detail" aria-label="All memories">
            <h2>All memories</h2>
            <ul className="graph-list">{[...memories].reverse().map(memoryListItem)}</ul>
          </section>
        ) : null}
      </>
    );
  };

  return (
    <div className={`experience graph-page${variant === "overlay" ? " graph-page--overlay" : ""}`}>
      <header className="graph-header">
        <Brand />
        {state.status === "ready" ? (
          <p className={`graph-connection graph-connection--${state.connection.kind}`}>
            <i aria-hidden="true" />
            Connected to {state.connection.label}
            {state.connection.instance ? ` · ${state.connection.instance}…` : ""}
          </p>
        ) : null}
        {variant === "overlay" ? (
          <button className="graph-back graph-back--button" type="button" onClick={onCollapse}>
            <CollapseIcon />
            Collapse to tab
          </button>
        ) : (
          <Link className="graph-back" href="/">
            ← Back to Mateo
          </Link>
        )}
      </header>

      <main className="graph-layout">
        <section className="graph-canvas" ref={canvasRef} aria-label="Memory graph">
          {state.status === "ready" ? (
            <>
              <svg
                ref={svgRef}
                className="graph-svg"
                role="group"
                aria-label="Memories and the people, places, objects and feelings they mention"
                onPointerDown={onBackgroundPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <g transform={`translate(${size.w / 2 + view.x} ${size.h / 2 + view.y}) scale(${view.k})`}>
                  {data?.links.map((link, index) => {
                    const from = positions.get(link.source);
                    const to = positions.get(link.target);
                    if (!from || !to) return null;

                    const active = linkIsActive(link);
                    const dim = emphasis !== null && !active;

                    return (
                      <g key={`${link.type}-${link.source}-${link.target}-${index}`}>
                        <line
                          className={`graph-link graph-link--${link.type === "RELATED_TO" ? "related" : "mentions"}${
                            dim ? " is-dim" : ""
                          }${active ? " is-active" : ""}`}
                          x1={from.x}
                          y1={from.y}
                          x2={to.x}
                          y2={to.y}
                        />
                        {link.type === "RELATED_TO" &&
                        active &&
                        link.label &&
                        (emphasis?.center !== null || (link.memoryId && emphasis?.ids.has(link.memoryId))) ? (
                          <text
                            className="graph-link-label"
                            x={(from.x + to.x) / 2}
                            y={(from.y + to.y) / 2 - 5}
                            textAnchor="middle"
                            aria-hidden="true"
                          >
                            {link.label}
                          </text>
                        ) : null}
                      </g>
                    );
                  })}
                  {data?.nodes.filter(isEntity).map(renderNode)}
                  {data?.nodes.filter(isMemory).map(renderNode)}
                </g>
              </svg>

              <details className="graph-key">
                <summary>Key</summary>
                <ul aria-label="Key">
                  <li>
                    <svg viewBox="-16 -16 32 32" aria-hidden="true"><circle className="graph-ring" r="11" /></svg>
                    Shared by Leo
                  </li>
                  <li>
                    <svg viewBox="-16 -16 32 32" aria-hidden="true">
                      <circle className="graph-story" r="12" />
                      <text className="graph-glyph" textAnchor="middle" dominantBaseline="central">✣</text>
                    </svg>
                    Mateo’s own stories
                  </li>
                  <li>
                    <svg viewBox="-16 -16 32 32" aria-hidden="true">
                      <circle className="graph-halo" r="11" />
                      <circle className="graph-dot graph-dot--place" r="6" />
                    </svg>
                    Shared by both
                  </li>
                  {KIND_ORDER.map((kind) => (
                    <li key={kind}>
                      <svg viewBox="-16 -16 32 32" aria-hidden="true"><circle className={`graph-dot graph-dot--${kind}`} r="7" /></svg>
                      {KIND_LABEL[kind]}
                    </li>
                  ))}
                </ul>
                <p>Dots are derived: an index over the memories, never a memory itself.</p>
              </details>

              <div className="graph-controls" role="group" aria-label="Zoom">
                <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">+</button>
                <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">−</button>
                <button type="button" onClick={resetView} aria-label="Fit graph to view">⌖</button>
              </div>

              {isEmpty ? (
                <div className="graph-empty">
                  <p>No memories yet.</p>
                  <p>
                    Add one on the right, or load the demo set with <code>npm run memory:seed</code>.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}

          {state.status === "loading" ? <p className="graph-state" role="status">Loading memories…</p> : null}

          {state.status === "error" ? (
            <div className="graph-state" role="alert">
              <p>{state.message}</p>
              <button className="graph-button" type="button" onClick={() => void refresh()}>Try again</button>
            </div>
          ) : null}

          {state.status === "unconfigured" ? (
            <div className="graph-state">
              <h2>The memory graph is not connected</h2>
              <p>Start a local Neo4j, add its address to <code>.env.local</code>, then load the demo set.</p>
              <pre>{`docker compose up -d
NEO4J_URI=bolt://localhost:7687
NEO4J_PASSWORD=emori-local-dev
npm run memory:seed`}</pre>
              {state.missing.length ? <p className="graph-note">Missing: {state.missing.join(", ")}</p> : null}
              <button className="graph-button" type="button" onClick={() => void refresh()}>Check again</button>
            </div>
          ) : null}
        </section>

        <aside className="graph-panel" aria-label="Memory tools">
          <Eyebrow warm>MEMORY GRAPH</Eyebrow>
          <h1>How memories connect</h1>
          <p className="graph-intro">
            Every memory is kept word for word. The dots around it are a derived index that helps Mateo find
            what matters. They never change what a memory says.
          </p>

          {data ? (
            <p className="graph-stats">
              {data.stats.memories} memories · {data.stats.entities} connections · {data.stats.links} links
              {sharedIds.size ? ` · ${sharedIds.size} shared` : ""}
            </p>
          ) : null}

          {state.status === "ready" ? (
            <>
              <div role="tablist" aria-label="Memory tools" className="graph-tabs">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    id={`graph-tab-${item.id}`}
                    role="tab"
                    type="button"
                    aria-selected={tab === item.id}
                    aria-controls={`graph-panel-${item.id}`}
                    tabIndex={tab === item.id ? 0 : -1}
                    onClick={() => setTab(item.id)}
                    onKeyDown={onTabKeyDown}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div aria-live="polite">{notice ? <p className="graph-notice" role="status">{notice}</p> : null}</div>

              {highlight ? (
                <div className="graph-banner">
                  <span>{highlight.label}</span>
                  <button type="button" onClick={clearHighlight}>Clear</button>
                </div>
              ) : null}

              <div role="tabpanel" id="graph-panel-explore" aria-labelledby="graph-tab-explore" hidden={tab !== "explore"}>
                {selected ? (
                  <>
                    <button className="graph-back-link" type="button" onClick={() => select(null)}>← All memories</button>
                    {exploreDetail()}
                    <div className="graph-trace">
                      <label htmlFor="graph-trace">Trace a connection to…</label>
                      <select id="graph-trace" value={traceTarget} onChange={(event) => trace(selected.id, event.target.value)}>
                        <option value="">Choose a memory or connection</option>
                        <optgroup label="Memories">
                          {traceOptions.filter(isMemory).map((node) => (
                            <option key={node.id} value={node.id}>{nodeName(node)}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Connections">
                          {traceOptions.filter(isEntity).map((node) => (
                            <option key={node.id} value={node.id}>{nodeName(node)}</option>
                          ))}
                        </optgroup>
                      </select>
                      {tracePath ? (
                        <ol className="graph-path" aria-label="Path">
                          {tracePath.map((id) => {
                            const node = nodeById.get(id);
                            return node ? (
                              <li key={id}>
                                <button type="button" onClick={() => select(id, { keepHighlight: true })}>{nodeName(node)}</button>
                              </li>
                            ) : null;
                          })}
                        </ol>
                      ) : null}
                    </div>
                  </>
                ) : (
                  exploreDetail()
                )}
              </div>

              <div role="tabpanel" id="graph-panel-add" aria-labelledby="graph-tab-add" hidden={tab !== "add"}>
                <AddPanel agent={agent} onSaved={onSaved} />
              </div>

              <div role="tabpanel" id="graph-panel-ask" aria-labelledby="graph-tab-ask" hidden={tab !== "ask"}>
                <AskPanel
                  agent={agent}
                  onAnswer={onAnswer}
                  onCite={(id) => select(id, { keepHighlight: true, openExplore: true })}
                />
              </div>
            </>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
