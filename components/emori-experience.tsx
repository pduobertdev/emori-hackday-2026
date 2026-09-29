"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowUpIcon, MicrophoneIcon } from "./icons";
import { MemoryDialog } from "./memory-dialog";
import { Brand, CharacterHeading, Eyebrow, MemoryButton } from "./primitives";

type ExperienceMode = "intro" | "conversation";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const initialReply = "It’s good to hear from you,\nLeo. What’s on your mind?";
const initialHistory: ChatMessage[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: initialReply },
];

export function EmoriExperience() {
  const [mode, setMode] = useState<ExperienceMode>("intro");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState("");
  const [latestMessage, setLatestMessage] = useState("hi");
  const [mateoReply, setMateoReply] = useState(initialReply);
  const [history, setHistory] = useState<ChatMessage[]>(initialHistory);
  const [isGenerating, setIsGenerating] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [mode]);

  const beginVoiceConversation = () => {
    if (!listening) {
      setListening(true);
      return;
    }
    setListening(false);
    setMode("conversation");
  };

  const startNewConversation = () => {
    setLatestMessage("hi");
    setMateoReply(initialReply);
    setHistory(initialHistory);
    setMessage("");
    setRuntimeError("");
    setIsGenerating(false);
    setListening(false);
    setMode("conversation");
  };

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextMessage = message.trim();
    if (!nextMessage || isGenerating) return;

    const pendingHistory: ChatMessage[] = [
      ...history,
      { role: "user", content: nextMessage },
    ];

    setLatestMessage(nextMessage);
    setMateoReply("");
    setHistory(pendingHistory);
    setMessage("");
    setRuntimeError("");
    setIsGenerating(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: pendingHistory }),
      });

      if (!response.ok) {
        const details = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(details?.error || "Mateo could not answer right now.");
      }

      if (!response.body) throw new Error("Mateo returned an empty response.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let completeReply = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        completeReply += decoder.decode(value, { stream: true });
        setMateoReply(completeReply);
      }

      completeReply += decoder.decode();
      if (!completeReply.trim()) throw new Error("Mateo returned an empty response.");

      setHistory([...pendingHistory, { role: "assistant", content: completeReply }]);
    } catch (error) {
      setMateoReply("I’m here with you. The connection to my voice isn’t ready yet.");
      setRuntimeError(error instanceof Error ? error.message : "Mateo could not answer right now.");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <main className={`experience experience--${mode}`}>
      <header className="site-header">
        <Brand />
        <MemoryButton onClick={() => setDialogOpen(true)} />
      </header>

      {mode === "intro" ? (
        <section className="intro" aria-label="Talk to Mateo">
          <CharacterHeading />
          <p className="intro__quote">Some memories shouldn’t end when<br className="desktop-break" /> the conversation does.</p>

          <div className="voice-panel">
            <button
              className={`voice-orb${listening ? " voice-orb--listening" : ""}`}
              type="button"
              onClick={beginVoiceConversation}
              aria-pressed={listening}
              aria-label={listening ? "Finish voice message" : "Start speaking to Mateo"}
            >
              <span className="voice-orb__halo" aria-hidden="true" />
              <MicrophoneIcon />
            </button>
            <p className="voice-panel__label">{listening ? "LISTENING… TAP WHEN DONE" : "TALK TO MATEO"}</p>
            <p className="voice-panel__hint">
              {listening ? "Mateo is listening." : "Tap the ring and speak."}{" "}
              <button type="button" onClick={() => setMode("conversation")}>Type instead</button>
            </p>
            <button className="text-link" type="button" onClick={startNewConversation}>New conversation</button>
          </div>

          <footer className="intro-footer">
            <p>AI-generated replies · fictional demonstration data</p>
            <label className="speak-toggle">
              <input type="checkbox" defaultChecked />
              <span aria-hidden="true">✓</span>
              Speak replies aloud
            </label>
          </footer>
        </section>
      ) : (
        <section className="conversation" aria-label="Conversation with Mateo">
          <CharacterHeading compact />
          <div className="conversation-rule"><span>NEW CONVERSATION</span></div>

          <div className="conversation-body" aria-live="polite" aria-busy={isGenerating}>
            <div className="user-message">
              <Eyebrow>LEO</Eyebrow>
              <p>{latestMessage}</p>
            </div>
            <article className="mateo-message">
              <Eyebrow warm>MATEO <span>· AI-GENERATED</span></Eyebrow>
              <p className={mateoReply.length > 120 ? "mateo-message__text--long" : undefined}>
                {mateoReply || <span className="thinking-dots" aria-label="Mateo is thinking">•••</span>}
              </p>
            </article>
          </div>

          <div className="composer-dock">
            <form className="composer" onSubmit={submitMessage}>
              <label className="sr-only" htmlFor="message">Write to Mateo</label>
              <input
                id="message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Write to Mateo…"
                autoComplete="off"
                disabled={isGenerating}
              />
              <button type="submit" aria-label="Send message" disabled={isGenerating || !message.trim()}>
                <ArrowUpIcon />
              </button>
            </form>
            <button
              className={`voice-orb voice-orb--small${listening ? " voice-orb--listening" : ""}`}
              type="button"
              onClick={() => setListening((value) => !value)}
              aria-label={listening ? "Stop listening" : "Record a voice message"}
              aria-pressed={listening}
            >
              <MicrophoneIcon />
            </button>
            {runtimeError ? <p className="runtime-note" role="status">{runtimeError}</p> : null}
          </div>
        </section>
      )}

      <MemoryDialog open={dialogOpen} onClose={closeDialog} />
    </main>
  );
}
