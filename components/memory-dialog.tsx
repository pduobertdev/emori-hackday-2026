"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { CloseIcon } from "./icons";

type MemoryDialogProps = {
  open: boolean;
  onClose: () => void;
};

const memoryItems = [
  {
    title: "WHAT YOU TELL MATEO",
    description:
      "Saved word for word as something Leo shared. If it mentions an event and a day, Emori keeps that too.",
    tone: "ring",
  },
  {
    title: "BETWEEN CONVERSATIONS",
    description:
      "Nothing from a chat window is carried over. When a new conversation opens, Emori looks for what matters now.",
    tone: "muted",
  },
  {
    title: "MATEO’S REPLIES",
    description:
      "Written by AI, guided by Mateo’s own stories and by what Leo shared. Labeled as generated; never becomes one of Mateo’s memories.",
    tone: "solid",
  },
];

export function MemoryDialog({ open, onClose }: MemoryDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [memoryText, setMemoryText] = useState("");
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [usesGraph, setUsesGraph] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void fetch("/api/memory", { cache: "no-store" })
      .then(async (response) => {
        const result = (await response.json()) as { text?: string; store?: string; error?: string };
        if (!response.ok) throw new Error(result.error || "Could not load memory.");
        if (cancelled) return;
        setUsesGraph(result.store === "neo4j");
        setMemoryText(result.text || "");
      })
      .catch((error) => {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Could not load memory.");
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const saveText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setStatus("");

    try {
      const response = await fetch("/api/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: memoryText }),
      });
      const result = (await response.json()) as { store?: string; entities?: number; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not save memory.");

      if (result.store === "neo4j") {
        // The graph appends memories, so clear the box instead of leaving text to re-save.
        setMemoryText("");
        setStatus(`Saved as a new memory. Found ${result.entities ?? 0} connections.`);
      } else {
        setStatus("Text saved for future conversations.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save memory.");
    } finally {
      setIsSaving(false);
    }
  };

  const uploadImage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const image = imageInputRef.current?.files?.[0];
    if (!image) return;

    setIsSaving(true);
    setStatus("");

    try {
      const body = new FormData();
      body.set("image", image);
      const response = await fetch("/api/memory/image", { method: "POST", body });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not upload image.");
      setStatus("Image saved for future conversations.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not upload image.");
    } finally {
      setIsSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="dialog-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="memory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button ref={closeButtonRef} className="dialog-close" type="button" onClick={onClose} aria-label="Close memory explanation">
          <CloseIcon />
        </button>
        <h2 id="memory-dialog-title">How Emori remembers</h2>
        <p className="dialog-subtitle">What happens behind every answer.</p>

        <section className="memory-sample" aria-labelledby="memory-sample-title">
          <h3 id="memory-sample-title">DURABLE SAMPLE</h3>
          <form onSubmit={saveText}>
            <label htmlFor="memory-sample-text">{usesGraph ? "Add a memory" : "Reference text"}</label>
            <textarea
              id="memory-sample-text"
              value={memoryText}
              onChange={(event) => setMemoryText(event.target.value)}
              placeholder="Paste something Mateo should remember across sessions…"
              rows={4}
              disabled={isSaving}
            />
            <button type="submit" disabled={isSaving || !memoryText.trim()}>Save text</button>
          </form>

          <form onSubmit={uploadImage}>
            <label htmlFor="memory-sample-image">Reference JPEG</label>
            <input
              ref={imageInputRef}
              id="memory-sample-image"
              name="image"
              type="file"
              accept="image/jpeg"
              disabled={isSaving}
              required
            />
            <button type="submit" disabled={isSaving}>Upload image</button>
          </form>
          {status ? <p className="memory-sample__status" role="status">{status}</p> : null}
          {usesGraph ? (
            <p className="memory-sample__status">
              <Link href="/memory">See how your memories connect →</Link>
            </p>
          ) : null}
        </section>

        <div className="memory-timeline">
          {memoryItems.map((item) => (
            <article className="memory-item" key={item.title}>
              <span className={`timeline-dot timeline-dot--${item.tone}`} aria-hidden="true" />
              <div>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="memory-legend" aria-label="Memory source key">
          <span><i className="legend-ring" />Shared by Leo</span>
          <span><i className="legend-story">✣</i>Mateo’s own stories</span>
          <span><i className="legend-solid" />Generated by AI</span>
        </div>
      </section>
    </div>
  );
}
