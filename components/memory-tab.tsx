"use client";

import Link from "next/link";
import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightIcon, CloseIcon, ExpandIcon } from "./icons";
import { type ReadyState, loadGraphState, peekGraphState } from "./memory-graph-store";
import { MemoryPreview } from "./memory-preview";
import { MemoryTabAdd } from "./memory-tab-add";
import { Eyebrow } from "./primitives";
import type {
  GraphMemoryNode,
  MemoryGraphConnection,
  MemoryGraphData,
} from "../lib/memory/graph/types";

type MemoryTabProps = {
  open: boolean;
  /** The full memory page is open over the experience, so the tab steps aside. */
  expanded: boolean;
  onClose: () => void;
};

type Snapshot =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "file"; text: string }
  | { status: "graph"; data: MemoryGraphData; connection: MemoryGraphConnection };

type Segment = "overview" | "add";

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "add", label: "Add" },
];

const RULES = [
  {
    title: "WHAT YOU TELL MATEO",
    outcome: "Kept",
    description:
      "Saved word for word as something Leo shared. If it mentions an event and a day, Emori keeps that too.",
    tone: "ring",
  },
  {
    title: "BETWEEN CONVERSATIONS",
    outcome: "Not carried over",
    description:
      "Nothing from a chat window is carried over. When a new conversation opens, Emori looks for what matters now.",
    tone: "muted",
  },
  {
    title: "MATEO’S REPLIES",
    outcome: "Never kept",
    description:
      "Written by AI, guided by Mateo’s own stories and by what Leo shared. Labeled as generated; never becomes one of Mateo’s memories.",
    tone: "solid",
  },
] as const;

const RECENT_COUNT = 3;
const FRESH_MS = 4_500;

const graphSnapshot = (state: ReadyState): Snapshot => ({
  status: "graph",
  data: state.data,
  connection: state.connection,
});

/** Keep the object a view already has when a reload found nothing new, so nothing re-lays out. */
function mergeSnapshot(current: Snapshot, next: Snapshot): Snapshot {
  return current.status === "graph" &&
    next.status === "graph" &&
    current.connection.label === next.connection.label &&
    current.connection.instance === next.connection.instance &&
    JSON.stringify(current.data) === JSON.stringify(next.data)
    ? current
    : next;
}

async function loadSnapshot(force: boolean): Promise<Snapshot> {
  const state = await loadGraphState({ force });
  if (state.status === "ready") return graphSnapshot(state);
  if (state.status !== "unconfigured") {
    return { status: "error", message: state.status === "error" ? state.message : "Could not load memory." };
  }

  // No graph database: memory is the single reference text file.
  try {
    const response = await fetch("/api/memory", { cache: "no-store" });
    const file = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
    if (!response.ok) throw new Error(file?.error || "Could not load memory.");
    return { status: "file", text: file?.text ?? "" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not load memory." };
  }
}

const isMemory = (node: MemoryGraphData["nodes"][number]): node is GraphMemoryNode => node.type === "memory";

function whenLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function MemoryTab({ open, expanded, onClose }: MemoryTabProps) {
  const panelRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const expandRef = useRef<HTMLAnchorElement>(null);
  const wasExpandedRef = useRef(false);
  const [segment, setSegment] = useState<Segment>("overview");
  const [snapshot, setSnapshot] = useState<Snapshot>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const [freshId, setFreshId] = useState<string | null>(null);

  const visible = open && !expanded;
  const graph = snapshot.status === "graph" ? snapshot : null;

  // Show what was there before straight away and refresh it each time the tab opens or returns from the page.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    const cached = peekGraphState();
    if (cached) queueMicrotask(() => !cancelled && setSnapshot((current) => mergeSnapshot(current, graphSnapshot(cached))));

    // A version bump means something was just saved, so do not join a request that predates it.
    void loadSnapshot(version > 0).then((next) => {
      if (!cancelled) setSnapshot((current) => mergeSnapshot(current, next));
    });

    return () => {
      cancelled = true;
    };
  }, [visible, version]);

  // Move focus into the tab when it opens and hand it back to the handle when it closes.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const opener = document.activeElement as HTMLElement | null;
    titleRef.current?.focus({ preventScroll: true });

    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || panel.contains(active)) opener?.focus();
    };
  }, [open]);

  // When the full page collapses back into the tab, land on the control that expanded it.
  useEffect(() => {
    if (wasExpandedRef.current && !expanded && open) expandRef.current?.focus();
    wasExpandedRef.current = expanded;
  }, [expanded, open]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [visible, onClose]);

  useEffect(() => {
    if (!freshId) return;
    const timer = setTimeout(() => setFreshId(null), FRESH_MS);
    return () => clearTimeout(timer);
  }, [freshId]);

  const onSaved = useCallback((memoryId?: string) => {
    setFreshId(memoryId ?? null);
    setVersion((current) => current + 1);
  }, []);

  const onSegmentKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;

    event.preventDefault();
    const index = SEGMENTS.findIndex((item) => item.id === segment);
    const next = SEGMENTS[(index + step + SEGMENTS.length) % SEGMENTS.length].id;
    setSegment(next);
    document.getElementById(`memory-tab-tab-${next}`)?.focus();
  };

  const freshIds = useMemo(() => (freshId ? new Set([freshId]) : undefined), [freshId]);
  const recent = useMemo(
    () =>
      (graph?.data.nodes ?? [])
        .filter(isMemory)
        .filter((memory) => memory.source === "user")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, RECENT_COUNT),
    [graph],
  );

  const retry = () => {
    setSnapshot({ status: "loading" });
    setVersion((current) => current + 1);
  };

  const snapshotCard = () => {
    if (snapshot.status === "loading") {
      return <div className="memory-snapshot memory-snapshot--loading" role="status" aria-label="Loading your memories" />;
    }

    if (snapshot.status === "error") {
      return (
        <div className="memory-note" role="alert">
          <p>{snapshot.message}</p>
          <button className="memory-tab__ghost" type="button" onClick={retry}>Try again</button>
        </div>
      );
    }

    if (snapshot.status === "file") {
      return (
        <div className="memory-note">
          <h3>Memory is one reference text</h3>
          <p>
            Mateo reads a single text file. Connect a Neo4j graph and memories are kept one by one, with the people,
            places and feelings in them mapped.
          </p>
          <button className="memory-tab__ghost" type="button" onClick={() => setSegment("add")}>Edit reference text</button>
        </div>
      );
    }

    const { stats } = snapshot.data;
    if (stats.memories === 0) {
      return (
        <div className="memory-note">
          <h3>Nothing kept yet</h3>
          <p>Add a memory and it appears here, word for word, with the connections Emori finds in it.</p>
          <button className="memory-tab__ghost" type="button" onClick={() => setSegment("add")}>Add the first one</button>
        </div>
      );
    }

    return (
      <>
        <Link
          className="memory-snapshot"
          href="/memory"
          aria-label={`Open the full memory graph: ${plural(stats.memories, "memory", "memories")} and ${plural(stats.entities, "connection")}`}
        >
          <MemoryPreview data={snapshot.data} freshIds={freshIds} />
          <span className="memory-snapshot__bar">
            <span className="memory-snapshot__count">
              <strong>{stats.memories}</strong> {stats.memories === 1 ? "memory" : "memories"}
              <i aria-hidden="true" />
              <strong>{stats.entities}</strong> {stats.entities === 1 ? "connection" : "connections"}
            </span>
            <span className="memory-snapshot__cta">
              Open full graph <ExpandIcon />
            </span>
          </span>
        </Link>
        <p className={`memory-source memory-source--${snapshot.connection.kind}`}>
          <i aria-hidden="true" />
          Connected to {snapshot.connection.label}
          {snapshot.connection.instance ? ` · ${snapshot.connection.instance}…` : ""}
        </p>
      </>
    );
  };

  return (
    <>
      <div className="memory-tab__scrim" hidden={!visible} onClick={onClose} aria-hidden="true" />
      <section
        ref={panelRef}
        id="memory-tab"
        className="memory-tab"
        role="dialog"
        aria-modal="false"
        aria-labelledby="memory-tab-title"
        hidden={!visible}
      >
        <header className="memory-tab__head">
          <div className="memory-tab__titles">
            <Eyebrow warm>MEMORY</Eyebrow>
            <h2 id="memory-tab-title" ref={titleRef} tabIndex={-1}>How Emori remembers</h2>
            <p>What happens behind every answer.</p>
          </div>
          <div className="memory-tab__actions">
            {graph ? (
              <Link ref={expandRef} className="memory-tab__icon" href="/memory" aria-label="Expand to the full memory graph">
                <ExpandIcon />
              </Link>
            ) : null}
            <button className="memory-tab__icon" type="button" onClick={onClose} aria-label="Close memory tab">
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="memory-tab__segments" role="tablist" aria-label="Memory">
          {SEGMENTS.map((item) => (
            <button
              key={item.id}
              id={`memory-tab-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={segment === item.id}
              aria-controls={`memory-tab-panel-${item.id}`}
              tabIndex={segment === item.id ? 0 : -1}
              onClick={() => setSegment(item.id)}
              onKeyDown={onSegmentKeyDown}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="memory-tab__body">
          <div
            role="tabpanel"
            id="memory-tab-panel-overview"
            aria-labelledby="memory-tab-tab-overview"
            hidden={segment !== "overview"}
          >
            {snapshotCard()}

            <section className="memory-section" aria-labelledby="memory-rules-title">
              <h3 id="memory-rules-title" className="memory-section__title">HOW IT WORKS</h3>
              <ul className="memory-rules">
                {RULES.map((rule) => (
                  <li className="memory-rule" key={rule.title}>
                    <span className={`memory-dot memory-dot--${rule.tone}`} aria-hidden="true" />
                    <div className="memory-rule__top">
                      <h4>{rule.title}</h4>
                      <span className={`memory-rule__outcome memory-rule__outcome--${rule.tone}`}>{rule.outcome}</span>
                    </div>
                    <p>{rule.description}</p>
                  </li>
                ))}
              </ul>
              <div className="memory-legend" aria-label="Memory source key">
                <span><i className="legend-ring" />Shared by Leo</span>
                <span><i className="legend-story">✣</i>Mateo’s own stories</span>
                <span><i className="legend-solid" />Generated by AI</span>
              </div>
            </section>

            {graph && recent.length > 0 ? (
              <section className="memory-section" aria-labelledby="memory-recent-title">
                <h3 id="memory-recent-title" className="memory-section__title">RECENTLY KEPT</h3>
                <ul className="memory-recent">
                  {recent.map((memory) => (
                    <li key={memory.id}>
                      <Link
                        className={`memory-recent__item${memory.id === freshId ? " is-fresh" : ""}`}
                        href={`/memory?focus=${encodeURIComponent(memory.id)}`}
                        prefetch={false}
                      >
                        <span className="memory-recent__meta">
                          <i className="legend-ring" aria-hidden="true" />
                          Shared by Leo
                          <time dateTime={memory.createdAt}>{whenLabel(memory.createdAt)}</time>
                        </span>
                        <span className="memory-recent__text">{memory.text}</span>
                        <ArrowRightIcon className="memory-recent__arrow" />
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link className="memory-tab__link memory-recent__all" href="/memory">
                  See all {plural(graph.data.stats.memories, "memory", "memories")} on the graph <ArrowRightIcon />
                </Link>
              </section>
            ) : null}
          </div>

          <div
            role="tabpanel"
            id="memory-tab-panel-add"
            aria-labelledby="memory-tab-tab-add"
            hidden={segment !== "add"}
          >
            {snapshot.status === "graph" || snapshot.status === "file" ? (
              <MemoryTabAdd
                store={snapshot.status === "graph" ? "graph" : "file"}
                fileText={snapshot.status === "file" ? snapshot.text : ""}
                onSaved={onSaved}
                onViewMemories={() => setSegment("overview")}
              />
            ) : snapshot.status === "error" ? (
              <div className="memory-note" role="alert">
                <p>{snapshot.message}</p>
                <button className="memory-tab__ghost" type="button" onClick={retry}>Try again</button>
              </div>
            ) : (
              <p className="memory-add__status" role="status">Loading…</p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
