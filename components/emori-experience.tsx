"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpIcon, MicrophoneIcon } from "./icons";
import { MemoryDialog } from "./memory-dialog";
import { Brand, CharacterHeading, Eyebrow, MemoryButton } from "./primitives";

type ExperienceMode = "intro" | "conversation";
type VoiceState = "idle" | "requesting" | "recording" | "transcribing" | "error";

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
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [message, setMessage] = useState("");
  const [latestMessage, setLatestMessage] = useState("hi");
  const [mateoReply, setMateoReply] = useState(initialReply);
  const [history, setHistory] = useState<ChatMessage[]>(initialHistory);
  const [isGenerating, setIsGenerating] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const listening = voiceState === "recording";
  const voiceBusy = voiceState === "requesting" || voiceState === "transcribing";

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [mode]);

  const releaseMicrophone = useCallback(() => {
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const cancelVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }

    mediaRecorderRef.current = null;
    releaseMicrophone();
    setVoiceState("idle");
  }, [releaseMicrophone]);

  useEffect(() => () => {
    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }

    releaseMicrophone();
  }, [releaseMicrophone]);

  const transcribeRecording = useCallback(async (audio: Blob) => {
    if (!audio.size) {
      setRuntimeError("No audio was recorded. Please try again.");
      setVoiceState("error");
      return;
    }

    setVoiceState("transcribing");
    setRuntimeError("");

    const extension = audio.type.includes("mp4") ? "m4a" : "webm";
    const formData = new FormData();
    formData.append("file", audio, `emori-recording.${extension}`);

    try {
      const response = await fetch("/api/voice/transcribe", {
        method: "POST",
        body: formData,
      });
      const result = (await response.json().catch(() => null)) as
        | { text?: string; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(result?.error || "The recording could not be transcribed.");
      }

      const transcript = result?.text?.trim();
      if (!transcript) throw new Error("No speech was detected. Please try again.");

      setMessage(transcript);
      setMode("conversation");
      setVoiceState("idle");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "The recording could not be transcribed.");
      setVoiceState("error");
      setMode("conversation");
    }
  }, []);

  const stopVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    setVoiceState("transcribing");
    recorder.stop();
  }, []);

  const startVoiceRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRuntimeError("Voice recording is not supported in this browser.");
      setVoiceState("error");
      setMode("conversation");
      return;
    }

    setRuntimeError("");
    setVoiceState("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const preferredMimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      const mimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        releaseMicrophone();
        mediaRecorderRef.current = null;
        setRuntimeError("The browser could not record from this microphone.");
        setVoiceState("error");
      };
      recorder.onstop = () => {
        releaseMicrophone();
        mediaRecorderRef.current = null;
        const audio = new Blob(chunks, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        void transcribeRecording(audio);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setVoiceState("recording");
      recordingTimeoutRef.current = setTimeout(stopVoiceRecording, 60_000);
    } catch (error) {
      releaseMicrophone();
      mediaRecorderRef.current = null;
      const permissionDenied = error instanceof DOMException && error.name === "NotAllowedError";
      setRuntimeError(
        permissionDenied
          ? "Microphone access was denied. Enable it in your browser settings and try again."
          : "The microphone could not be started.",
      );
      setVoiceState("error");
      setMode("conversation");
    }
  }, [releaseMicrophone, stopVoiceRecording, transcribeRecording]);

  const handleVoiceButton = () => {
    if (listening) {
      stopVoiceRecording();
      return;
    }

    if (!voiceBusy) void startVoiceRecording();
  };

  const startNewConversation = () => {
    cancelVoiceRecording();
    setLatestMessage("hi");
    setMateoReply(initialReply);
    setHistory(initialHistory);
    setMessage("");
    setRuntimeError("");
    setIsGenerating(false);
    setMode("conversation");
  };

  const voiceLabel = {
    idle: "TALK TO MATEO",
    requesting: "ALLOW MICROPHONE ACCESS…",
    recording: "LISTENING… TAP WHEN DONE",
    transcribing: "TRANSCRIBING…",
    error: "TRY VOICE AGAIN",
  }[voiceState];

  const voiceHint = {
    idle: "Tap the ring and speak.",
    requesting: "Waiting for your browser.",
    recording: "Mateo is listening.",
    transcribing: "Turning your voice into text.",
    error: "The recording did not complete.",
  }[voiceState];

  const voiceStatus = voiceState === "transcribing"
    ? "Turning your voice into text…"
    : voiceState === "requesting"
      ? "Waiting for microphone permission…"
      : runtimeError;

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
              className={`voice-orb${listening ? " voice-orb--listening" : voiceBusy ? " voice-orb--processing" : ""}`}
              type="button"
              onClick={handleVoiceButton}
              disabled={voiceBusy}
              aria-pressed={listening}
              aria-label={listening ? "Finish voice message" : voiceBusy ? voiceLabel : "Start speaking to Mateo"}
            >
              <span className="voice-orb__halo" aria-hidden="true" />
              <MicrophoneIcon />
            </button>
            <p className="voice-panel__label">{voiceLabel}</p>
            <p className="voice-panel__hint">
              {voiceHint}{" "}
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
              className={`voice-orb voice-orb--small${listening ? " voice-orb--listening" : voiceBusy ? " voice-orb--processing" : ""}`}
              type="button"
              onClick={handleVoiceButton}
              disabled={voiceBusy || isGenerating}
              aria-label={listening ? "Stop listening" : voiceBusy ? voiceLabel : "Record a voice message"}
              aria-pressed={listening}
            >
              <MicrophoneIcon />
            </button>
            {voiceStatus ? <p className="runtime-note" role="status">{voiceStatus}</p> : null}
          </div>
        </section>
      )}

      <MemoryDialog open={dialogOpen} onClose={closeDialog} />
    </main>
  );
}
