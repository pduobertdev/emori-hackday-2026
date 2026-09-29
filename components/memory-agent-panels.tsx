"use client";

import { FormEvent, Fragment, useState } from "react";
import type { AskResult } from "../lib/memory/graph/ask";
import type { MemoryProposal } from "../lib/memory/graph/scout";
import type { AgentStatus } from "../lib/memory/graph/types";

const snippet = (text: string, length = 90) =>
  text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;

function AgentNeeded({ agent }: { agent: AgentStatus }) {
  if (agent.configured) return null;

  return (
    <p className="graph-note graph-note--warn">
      This needs a chat model, set up the same way as Mateo’s chat: <code>AI_PROVIDER</code>, <code>AI_MODEL</code> and
      the matching API key in <code>.env.local</code>, then restart the dev server.
    </p>
  );
}

async function readError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error || fallback;
}

type Candidate = MemoryProposal & { selected: boolean };

type AddPanelProps = {
  agent: AgentStatus;
  /** Called after memories are saved so the graph can reload and show them. */
  onSaved: (memoryIds: string[], notice: string) => Promise<void>;
};

/** Add a memory by hand, or let the scout propose passages from something Leo wrote. */
export function AddPanel({ agent, onSaved }: AddPanelProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const [note, setNote] = useState("");
  const [scouting, setScouting] = useState(false);
  const [scoutError, setScoutError] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);

  const saveByHand = async (event: FormEvent<HTMLFormElement>) => {
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
      if (!response.ok) throw new Error(await readError(response, "The memory could not be saved."));

      const saved = (await response.json()) as { memory: { id: string; extraction: string }; entities: number };
      setDraft("");
      await onSaved(
        [saved.memory.id],
        saved.memory.extraction === "done"
          ? `Saved word for word. Found ${saved.entities} connection${saved.entities === 1 ? "" : "s"}.`
          : "Saved word for word. Its connections could not be found yet.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const scout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!note.trim()) return;

    setScouting(true);
    setScoutError("");
    setCandidates(null);

    try {
      const response = await fetch("/api/memory/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Only what Leo wrote is sent, and the server reads only user-role text.
        body: JSON.stringify({ messages: [{ role: "user", content: note }] }),
      });
      if (!response.ok) throw new Error(await readError(response, "The scout could not read that."));

      const { proposals } = (await response.json()) as { proposals: MemoryProposal[] };
      setCandidates(proposals.map((proposal) => ({ ...proposal, selected: !proposal.duplicateOf })));
    } catch (error) {
      setScoutError(error instanceof Error ? error.message : "The scout could not read that.");
    } finally {
      setScouting(false);
    }
  };

  const toggle = (id: string) =>
    setCandidates((current) =>
      current?.map((candidate) => (candidate.id === id ? { ...candidate, selected: !candidate.selected } : candidate)) ?? null,
    );

  const approve = async () => {
    const chosen = (candidates ?? []).filter((candidate) => candidate.selected && !candidate.duplicateOf);
    if (chosen.length === 0) return;

    setBusy(true);
    setScoutError("");
    const savedIds: string[] = [];
    const savedProposals = new Set<string>();

    try {
      for (const candidate of chosen) {
        const response = await fetch("/api/memory/entries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: candidate.quote,
            eventDate: candidate.eventDate,
            via: "scout",
            extraction: { entities: candidate.entities, relations: candidate.relations },
          }),
        });
        if (!response.ok) throw new Error(await readError(response, "A memory could not be saved."));

        const saved = (await response.json()) as { memory: { id: string } };
        savedIds.push(saved.memory.id);
        savedProposals.add(candidate.id);
      }
    } catch (error) {
      setScoutError(error instanceof Error ? error.message : "A memory could not be saved.");
    } finally {
      setCandidates((current) => current?.filter((candidate) => !savedProposals.has(candidate.id)) ?? null);
      setBusy(false);
    }

    if (savedIds.length > 0) {
      await onSaved(savedIds, `Saved ${savedIds.length} memor${savedIds.length === 1 ? "y" : "ies"} you approved, word for word.`);
    }
  };

  const selectedCount = (candidates ?? []).filter((candidate) => candidate.selected && !candidate.duplicateOf).length;

  return (
    <div className="graph-tabpanel">
      <form className="graph-form" onSubmit={saveByHand}>
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
          {busy && !candidates ? "Saving…" : "Save memory"}
        </button>
        {notice ? <p className="graph-notice" role="status">{notice}</p> : null}
      </form>

      <section className="graph-agent" aria-labelledby="scout-heading">
        <h2 id="scout-heading">Memory scout</h2>
        <p className="graph-note">
          Paste something you wrote or said. The scout suggests passages worth keeping and quotes them exactly.
          Nothing is saved until you approve it.
        </p>

        <form className="graph-form" onSubmit={scout}>
          <label htmlFor="graph-scout-text" className="visually-hidden">Something you wrote</label>
          <textarea
            id="graph-scout-text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="A journal entry, a message, a story you told…"
            rows={4}
            disabled={scouting || busy || !agent.configured}
          />
          <button className="graph-button graph-button--quiet" type="submit" disabled={scouting || busy || !note.trim() || !agent.configured}>
            {scouting ? "Reading…" : "Find memories"}
          </button>
        </form>
        <AgentNeeded agent={agent} />
        {scoutError ? <p className="graph-notice" role="alert">{scoutError}</p> : null}

        {candidates ? (
          candidates.length === 0 ? (
            <p className="graph-note">Nothing here stood out as worth keeping.</p>
          ) : (
            <div className="graph-proposals">
              <ul>
                {candidates.map((candidate) => (
                  <li key={candidate.id} className={candidate.duplicateOf ? "is-duplicate" : undefined}>
                    <label>
                      <input
                        type="checkbox"
                        checked={candidate.selected && !candidate.duplicateOf}
                        disabled={!!candidate.duplicateOf || busy}
                        onChange={() => toggle(candidate.id)}
                      />
                      <span className="graph-proposal__body">
                        <blockquote>{candidate.quote}</blockquote>
                        {candidate.why ? <span className="graph-proposal__why">{candidate.why}</span> : null}
                        {candidate.duplicateOf ? <span className="graph-proposal__flag">Already saved</span> : null}
                        {candidate.entities.length ? (
                          <span className="graph-proposal__chips">
                            {candidate.entities.map((entity) => (
                              <span key={entity.key}>
                                <i className={`graph-swatch graph-swatch--${entity.kind}`} aria-hidden="true" />
                                {entity.name}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <button className="graph-button" type="button" disabled={busy || selectedCount === 0} onClick={() => void approve()}>
                {busy ? "Saving…" : `Save ${selectedCount} selected`}
              </button>
            </div>
          )
        ) : null}
      </section>
    </div>
  );
}

type AskPanelProps = {
  agent: AgentStatus;
  onAnswer: (result: AskResult) => void;
  onCite: (memoryId: string) => void;
};

const SUGGESTIONS = [
  "What do Leo’s memories and Mateo’s stories have in common?",
  "Which people matter most here?",
  "What feelings keep coming up?",
];

/** Ask a question of the saved memories. Answers are AI-generated, cited, and never stored. */
export function AskPanel({ agent, onAnswer, onCite }: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<(AskResult & { model?: string }) | null>(null);

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/memory/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      if (!response.ok) throw new Error(await readError(response, "The question could not be answered."));

      const answered = (await response.json()) as AskResult & { model?: string };
      setResult(answered);
      onAnswer(answered);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The question could not be answered.");
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(question);
  };

  return (
    <div className="graph-tabpanel">
      <p className="graph-note">
        Ask about what has been saved. The answer uses only these memories and cites them, and the cited memories
        light up on the graph.
      </p>

      <form className="graph-form" onSubmit={onSubmit}>
        <label htmlFor="graph-question">Your question</label>
        <textarea
          id="graph-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="What do these memories have in common?"
          rows={2}
          disabled={busy || !agent.configured}
        />
        <button className="graph-button" type="submit" disabled={busy || !question.trim() || !agent.configured}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
      <AgentNeeded agent={agent} />

      {error ? <p className="graph-notice" role="alert">{error}</p> : null}

      {result ? (
        <section className="graph-answer" aria-label="Answer" aria-live="polite">
          <p className="graph-chip graph-chip--generated">
            <i className="graph-swatch graph-swatch--generated" aria-hidden="true" />
            Generated by AI · not saved
          </p>
          <p className="graph-answer__text">
            {result.answer.split(/(\[\d+\])/).map((part, index) => {
              const match = /^\[(\d+)\]$/.exec(part);
              const evidence = match ? result.evidence[Number(match[1]) - 1] : undefined;

              return evidence ? (
                <button key={index} className="graph-cite" type="button" onClick={() => onCite(evidence.id)} aria-label={`Show memory ${evidence.n}`}>
                  {evidence.n}
                </button>
              ) : (
                <Fragment key={index}>{part}</Fragment>
              );
            })}
          </p>

          <h2>Evidence</h2>
          {result.cited.length === 0 ? <p className="graph-note">The answer did not cite a memory.</p> : null}
          <ol className="graph-evidence">
            {result.evidence
              .filter((item) => result.cited.includes(item.id))
              .map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => onCite(item.id)}>
                    <span className="graph-list__source">
                      {item.n} · {item.source === "mateo_story" ? "✣ Mateo’s story" : "Leo"}
                    </span>
                    {snippet(item.text, 120)}
                  </button>
                </li>
              ))}
          </ol>
        </section>
      ) : null}

      {agent.configured ? (
        <ul className="graph-suggestions" aria-label="Suggested questions">
          {SUGGESTIONS.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setQuestion(suggestion);
                  void submit(suggestion);
                }}
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
