import { requireSession } from "@/lib/auth/session";

const ELEVENLABS_TRANSCRIPTION_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

type ElevenLabsTranscript = {
  text?: unknown;
  detail?: unknown;
};

export const runtime = "nodejs";
export const maxDuration = 60;

function getUpstreamError(payload: ElevenLabsTranscript) {
  if (typeof payload.detail === "string") return payload.detail;

  if (
    payload.detail &&
    typeof payload.detail === "object" &&
    "message" in payload.detail &&
    typeof payload.detail.message === "string"
  ) {
    return payload.detail.message;
  }

  return "ElevenLabs could not transcribe this recording.";
}

export async function POST(request: Request) {
  const session = requireSession(request);
  if (session instanceof Response) return session;

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();

  if (!apiKey) {
    return Response.json(
      { error: "Voice transcription is not configured. Add ELEVENLABS_API_KEY." },
      { status: 503 },
    );
  }

  let incomingForm: FormData;

  try {
    incomingForm = await request.formData();
  } catch {
    return Response.json({ error: "The audio upload could not be read." }, { status: 400 });
  }

  const file = incomingForm.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "A non-empty audio recording is required." }, { status: 400 });
  }

  if (file.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: "The recording must be smaller than 20 MB." }, { status: 413 });
  }

  if (!file.type.startsWith("audio/") && file.type !== "video/webm") {
    return Response.json({ error: "The uploaded file must be an audio recording." }, { status: 415 });
  }

  const elevenLabsForm = new FormData();
  elevenLabsForm.append("file", file, file.name || "emori-recording.webm");
  elevenLabsForm.append("model_id", "scribe_v2");
  elevenLabsForm.append("tag_audio_events", "false");
  elevenLabsForm.append("diarize", "false");

  let response: Response;

  try {
    response = await fetch(ELEVENLABS_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: elevenLabsForm,
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: "The transcription service could not be reached." }, { status: 502 });
  }

  const payload = (await response.json().catch(() => ({}))) as ElevenLabsTranscript;

  if (!response.ok) {
    return Response.json({ error: getUpstreamError(payload) }, { status: response.status });
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";

  if (!text) {
    return Response.json({ error: "No speech was detected in the recording." }, { status: 422 });
  }

  return Response.json(
    { text },
    { headers: { "Cache-Control": "no-store" } },
  );
}
