"use client";

import Link from "next/link";
import {
  FormEvent,
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
import { Brand, Eyebrow } from "./primitives";
import type {
  EntityKind,
  GraphEntityNode,
  GraphLink,
  GraphMemoryNode,
  GraphNode,
  MemoryGraphConnection,
  MemoryGraphData,
} from "../lib/memory/graph/types";

type LoadState =
  | { status: "loading" }
  | { status: "unconfigured"; missing: string[] }
  | { status: "error"; message: string }
  | { status: "ready"; data: MemoryGraphData; connection: MemoryGraphConnection };

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

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD = 4;

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
  if (extractor === "heuristic") return "These connections came from a simple word-matching pass, not a model.";
  if (extractor.startsWith("llm:")) return `These connections were found by ${extractor.slice(4)}.`;
  return "These connections are derived.";
}

async function fetchGraphState(): Promise<LoadState> {
  try {
    const response = await fetch("/api/memory/graph", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as
      | (Partial<MemoryGraphData> & {
          configured?: boolean;
          connection?: MemoryGraphConnection;
          missing?: string[];
          error?: string;
        })
      | null;

    if (!response.ok) throw new Error(body?.error || "The memory graph could not be loaded.");
    if (!body || body.configured === false) return { status: "unconfigured", missing: body?.missing ?? [] };

    return {
      status: "ready",
      data: body as MemoryGraphData,
      connection: body.connection ?? { kind: "remote", label: "Remote Neo4j" },
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The memory graph could not be loaded.",
    };
  }
}

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function MemoryGraphView() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [positions, setPositions] = useState<Map<string, Point>>(new Map());
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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

  const data = state.status === "ready" ? state.data : undefined;

  const load = useCallback(async () => setState(await fetchGraphState()), []);

  useEffect(() => {
    let cancelled = false;

    void fetchGraphState().then((next) => {
      if (!cancelled) setState(next);
    });

    return () => {
      cancelled = true;
    };
  }, []);

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
          .distance((link) => (link.link.type === "RELATED_TO" ? 70 : 92))
          .strength(0.5),
      )
      .force("charge", forceManyBody<SimNode>().strength((node) => (node.radius > 12 ? -430 : -170)))
      .force("collide", forceCollide<SimNode>().radius((node) => node.radius + 14))
      .force("x", forceX<SimNode>(0).strength(0.045))
      .force("y", forceY<SimNode>(0).strength(0.045))
      .alphaDecay(0.025)
      .stop();

    simulation.tick(reducedMotion ? 320 : 110);
    simNodesRef.current = nodes;
    simRef.current = simulation;
    setPositions(new Map(nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }])));

    simulation.on("end", () => {
      if (!viewTouchedRef.current) fitToView();
    });

    if (reducedMotion) {
      // No animation: the layout is already settled, so fit it now via the same callback path.
      queueMicrotask(() => {
        if (!viewTouchedRef.current) fitToView();
      });
    } else {
      simulation.on("tick", publishPositions).alpha(0.3).restart();
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

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const link of data?.links ?? []) {
      if (!map.has(link.source)) map.set(link.source, new Set());
      if (!map.has(link.target)) map.set(link.target, new Set());
      map.get(link.source)?.add(link.target);
      map.get(link.target)?.add(link.source);
    }
    return map;
  }, [data]);

  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const focusId = hoverId ?? (selected ? selected.id : null);
  const neighbors = focusId ? adjacency.get(focusId) : undefined;

  const toWorld = (clientX: number, clientY: number): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    return {
      x: (clientX - (rect?.left ?? 0) - size.w / 2 - view.x) / view.k,
      y: (clientY - (rect?.top ?? 0) - size.h / 2 - view.y) / view.k,
    };
  };

  const select = (id: string | null) => {
    setSelectedId(id);
    setConfirmingDelete(false);
    setNotice("");
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
      if (!drag.moved) select(drag.node.id);
    } else if (!drag.moved) {
      select(null);
    }
  };

  const onNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(id);
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

  const saveMemory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.trim()) return;

    setBusy(true);
    setNotice("");

    try {
      const response = await fetch("/api/memory/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft }),
      });
      const body = (await response.json().catch(() => null)) as
        | { memory?: { id: string; extraction: string }; entities?: number; error?: string }
        | null;

      if (!response.ok || !body?.memory) throw new Error(body?.error || "The memory could not be saved.");

      setDraft("");
      await load();
      setSelectedId(body.memory.id);
      setNotice(
        body.memory.extraction === "done"
          ? `Saved word for word. Found ${body.entities ?? 0} connection${body.entities === 1 ? "" : "s"}.`
          : "Saved word for word. Its connections could not be found yet.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory could not be saved.");
    } finally {
      setBusy(false);
    }
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
      await load();
      setNotice("Memory erased, along with any connections only it supported.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory could not be erased.");
    } finally {
      setBusy(false);
    }
  };

  const memories = (data?.nodes ?? []).filter(isMemory);
  const isEmpty = state.status === "ready" && memories.length === 0;

  const linkIsActive = (link: GraphLink) =>
    focusId !== null && (link.source === focusId || link.target === focusId || link.memoryId === focusId);

  const nodeIsDim = (id: string) => focusId !== null && id !== focusId && !neighbors?.has(id);

  const renderNode = (node: GraphNode) => {
    const point = positions.get(node.id) ?? { x: 0, y: 0 };
    const dim = nodeIsDim(node.id);
    const isSelected = node.id === selectedId;
    const showLabel = isEntity(node) || node.id === focusId;
    const label = isEntity(node) ? node.name : snippet(node.text, 48);
    const aria = isEntity(node)
      ? `${KIND_LABEL[node.kind]}: ${node.name}, in ${node.mentions} ${node.mentions === 1 ? "memory" : "memories"}`
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
        {isEntity(node) ? (
          <circle className={`graph-dot graph-dot--${node.kind}`} r={radiusFor(node)} />
        ) : node.source === "mateo_story" ? (
          <>
            <circle className="graph-story" r={radiusFor(node)} />
            <text className="graph-glyph" textAnchor="middle" dominantBaseline="central" aria-hidden="true">
              ✣
            </text>
          </>
        ) : (
          <circle className="graph-ring" r={radiusFor(node)} />
        )}
        {showLabel ? (
          <text
            className={`graph-label${isMemory(node) ? " graph-label--memory" : ""}`}
            y={radiusFor(node) + 15}
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

  return (
    <div className="experience graph-page">
      <header className="graph-header">
        <Brand />
        {state.status === "ready" ? (
          <p className={`graph-connection graph-connection--${state.connection.kind}`}>
            <i aria-hidden="true" />
            Connected to {state.connection.label}
            {state.connection.instance ? ` · ${state.connection.instance}…` : ""}
          </p>
        ) : null}
        <Link className="graph-back" href="/">
          ← Back to Mateo
        </Link>
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
                    const dim = focusId !== null && !active;

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
                        {link.type === "RELATED_TO" && active && link.label ? (
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
              <button className="graph-button" type="button" onClick={() => void load()}>Try again</button>
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
              <button className="graph-button" type="button" onClick={() => void load()}>Check again</button>
            </div>
          ) : null}
        </section>

        <aside className="graph-panel" aria-label="Memory details">
          <Eyebrow warm>MEMORY GRAPH</Eyebrow>
          <h1>How memories connect</h1>
          <p className="graph-intro">
            Every memory is kept word for word. The dots around it are a derived index that helps Mateo find
            what matters. They never change what a memory says.
          </p>

          {data ? (
            <p className="graph-stats">
              {data.stats.memories} memories · {data.stats.entities} connections · {data.stats.links} links
            </p>
          ) : null}

          <ul className="graph-legend" aria-label="Key">
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
            {KIND_ORDER.map((kind) => (
              <li key={kind}>
                <svg viewBox="-16 -16 32 32" aria-hidden="true"><circle className={`graph-dot graph-dot--${kind}`} r="7" /></svg>
                {KIND_LABEL[kind]} <span className="graph-legend__hint">derived</span>
              </li>
            ))}
          </ul>

          <div aria-live="polite">{notice ? <p className="graph-notice" role="status">{notice}</p> : null}</div>

          {selected && isMemory(selected) ? (
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
              {[...(adjacency.get(selected.id) ?? [])].length ? (
                <ul className="graph-chips">
                  {[...(adjacency.get(selected.id) ?? [])]
                    .map((id) => nodeById.get(id))
                    .filter((node): node is GraphEntityNode => !!node && isEntity(node))
                    .map((entity) => (
                      <li key={entity.id}>
                        <button type="button" onClick={() => select(entity.id)}>
                          <i className={`graph-swatch graph-swatch--${entity.kind}`} aria-hidden="true" />
                          {entity.name}
                        </button>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="graph-note">Nothing found yet.</p>
              )}
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
          ) : null}

          {selected && isEntity(selected) ? (
            <section className="graph-detail" aria-label="Selected connection">
              <p className="graph-chip">
                <i className={`graph-swatch graph-swatch--${selected.kind}`} aria-hidden="true" />
                {KIND_LABEL[selected.kind]} · derived
              </p>
              <h2 className="graph-entity-name">{selected.name}</h2>
              <p className="graph-meta">
                In {selected.mentions} {selected.mentions === 1 ? "memory" : "memories"}
              </p>

              {relationsOf(selected).length ? (
                <ul className="graph-relations">
                  {relationsOf(selected).map((link, index) => (
                    <li key={`${link.source}-${link.target}-${index}`}>
                      <button type="button" onClick={() => select(link.source === selected.id ? link.target : link.source)}>
                        {nodeById.get(link.source)?.type === "entity" ? (nodeById.get(link.source) as GraphEntityNode).name : ""}
                        {" — "}
                        {link.label}
                        {" → "}
                        {nodeById.get(link.target)?.type === "entity" ? (nodeById.get(link.target) as GraphEntityNode).name : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <h2>Mentioned in</h2>
              <ul className="graph-list">
                {entityMemories(selected).map((memory) => (
                  <li key={memory.id}>
                    <button type="button" onClick={() => select(memory.id)}>
                      <span className="graph-list__source">
                        {memory.source === "mateo_story" ? "✣ Mateo’s story" : "Leo"}
                      </span>
                      {snippet(memory.text, 110)}
                    </button>
                  </li>
                ))}
              </ul>
              <button className="graph-button graph-button--quiet" type="button" onClick={() => select(null)}>
                Back to all memories
              </button>
            </section>
          ) : null}

          {!selected && memories.length > 0 ? (
            <section className="graph-detail" aria-label="All memories">
              <h2>All memories</h2>
              <ul className="graph-list">
                {[...memories].reverse().map((memory) => (
                  <li key={memory.id}>
                    <button type="button" onClick={() => select(memory.id)}>
                      <span className="graph-list__source">
                        {memory.source === "mateo_story" ? "✣ Mateo’s story" : "Leo"}
                      </span>
                      {snippet(memory.text, 110)}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {state.status === "ready" ? (
            <form className="graph-form" onSubmit={saveMemory}>
              <label htmlFor="graph-memory-text">Add a memory</label>
              <textarea
                id="graph-memory-text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Something Mateo should remember, in your own words…"
                rows={3}
                disabled={busy}
              />
              <button className="graph-button" type="submit" disabled={busy || !draft.trim()}>
                {busy ? "Saving…" : "Save memory"}
              </button>
            </form>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
