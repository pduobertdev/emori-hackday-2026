"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MemoryGraphView } from "./memory-graph";

/** Matches the stage-out animation in globals.css. */
const CLOSE_MS = 240;

/**
 * The memory tab grown to the full memory page, laid over the experience. The conversation stays
 * mounted underneath (same recording, same messages), and going back closes it.
 */
export function MemoryStage() {
  const router = useRouter();
  const stageRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closing, setClosing] = useState(false);

  const collapse = useCallback(() => {
    if (closeTimerRef.current) return;
    setClosing(true);
    // Let the page shrink back toward the tab, then step back in history to reveal it.
    closeTimerRef.current = setTimeout(() => router.back(), CLOSE_MS);
  }, [router]);

  // Browser Back removes the stage without this timer; make sure it cannot go back a second time.
  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    stage.focus({ preventScroll: true });

    // The stage is modal: freeze the page behind it and take it out of the tab order.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const behind = [...document.body.children].filter(
      (element) => element !== stage && element.tagName !== "SCRIPT" && !element.tagName.startsWith("NEXT"),
    );
    behind.forEach((element) => element.setAttribute("inert", ""));

    return () => {
      document.body.style.overflow = previousOverflow;
      behind.forEach((element) => element.removeAttribute("inert"));
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) collapse();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [collapse]);

  return (
    <div
      ref={stageRef}
      className={`memory-stage${closing ? " memory-stage--closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Memory graph"
      tabIndex={-1}
    >
      <MemoryGraphView variant="overlay" onCollapse={collapse} />
    </div>
  );
}
