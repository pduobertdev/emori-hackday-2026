"use client";

import Link from "next/link";
import { FormEvent, useRef, useState } from "react";
import { ArrowRightIcon } from "./icons";

type MemoryTabAddProps = {
  /** "graph" appends memories one by one; "file" edits a single reference text. */
  store: "graph" | "file";
  /** The current reference text. Only used by the file store. */
  fileText: string;
  /** Called after a text save so the tab can reload what it shows. */
  onSaved: (memoryId?: string) => void;
  /** Jump back to the overview, where saved memories are listed. */
  onViewMemories: () => void;
};

type Status = { message: string; savedToGraph: boolean };

/** Add something for Mateo to remember, or attach a reference image. */
export function MemoryTabAdd({ store, fileText, onSaved, onViewMemories }: MemoryTabAddProps) {
  const usesGraph = store === "graph";
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(usesGraph ? "" : fileText);
  const [seenFileText, setSeenFileText] = useState(fileText);
  const [status, setStatus] = useState<Status | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // The reference text arrives after the tab opens; take it in unless the user is on the graph store.
  if (fileText !== seenFileText) {
    setSeenFileText(fileText);
    if (!usesGraph) setText(fileText);
  }

  const saveText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setStatus(null);

    try {
      const response = await fetch("/api/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const result = (await response.json().catch(() => null)) as
        | { store?: string; entities?: number; memory?: { id?: string }; error?: string }
        | null;
      if (!response.ok) throw new Error(result?.error || "Could not save memory.");

      if (result?.store === "neo4j") {
        // The graph appends memories, so clear the box instead of leaving text to re-save.
        setText("");
        setStatus({
          message: `Saved as a new memory. Found ${result.entities ?? 0} connection${result.entities === 1 ? "" : "s"}.`,
          savedToGraph: true,
        });
        onSaved(result.memory?.id);
      } else {
        setStatus({ message: "Text saved for future conversations.", savedToGraph: false });
        onSaved();
      }
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : "Could not save memory.", savedToGraph: false });
    } finally {
      setIsSaving(false);
    }
  };

  const uploadImage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const image = imageInputRef.current?.files?.[0];
    if (!image) return;

    setIsSaving(true);
    setStatus(null);

    try {
      const body = new FormData();
      body.set("image", image);
      const response = await fetch("/api/memory/image", { method: "POST", body });
      const result = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Could not upload image.");

      form.reset();
      setStatus({ message: "Image saved for future conversations.", savedToGraph: false });
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : "Could not upload image.", savedToGraph: false });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="memory-add">
      <form className="memory-add__form" onSubmit={saveText}>
        <label htmlFor="memory-tab-text">{usesGraph ? "Add a memory" : "Reference text"}</label>
        <textarea
          id="memory-tab-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={
            usesGraph
              ? "Something Mateo should remember, in your own words…"
              : "Paste something Mateo should remember across sessions…"
          }
          rows={5}
          disabled={isSaving}
        />
        <div className="memory-add__row">
          <p>{usesGraph ? "Kept word for word. Emori then finds the people, places and feelings in it." : "Replaces the reference text Mateo reads from."}</p>
          <button className="memory-tab__solid" type="submit" disabled={isSaving || !text.trim()}>
            {usesGraph ? "Save memory" : "Save text"}
          </button>
        </div>
      </form>

      <form className="memory-add__form memory-add__form--image" onSubmit={uploadImage}>
        <label htmlFor="memory-tab-image">Reference JPEG</label>
        <div className="memory-add__row">
          <input ref={imageInputRef} id="memory-tab-image" name="image" type="file" accept="image/jpeg" disabled={isSaving} required />
          <button className="memory-tab__ghost" type="submit" disabled={isSaving}>Upload image</button>
        </div>
      </form>

      <div aria-live="polite">
        {status ? (
          <p className="memory-add__status" role="status">
            {status.message}
            {status.savedToGraph ? (
              <>
                {" "}
                <button className="memory-tab__link" type="button" onClick={onViewMemories}>See it in your memories</button>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {usesGraph ? (
        <p className="memory-add__more">
          Have something longer? The memory scout can suggest passages from what you paste.{" "}
          <Link href="/memory?tab=add" className="memory-tab__link">
            Try it on the full page <ArrowRightIcon />
          </Link>
        </p>
      ) : null}
    </div>
  );
}
