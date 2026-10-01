import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/voice/transcribe/route";
import { createSession, signSession } from "../lib/auth/session";

const SECRET = "voice-secret-0123456789-abcdefghij";

function authed(body: FormData): Request {
  process.env.EMORI_SESSION_SECRET = SECRET;
  const token = signSession(createSession({ tenantId: "demo", userId: "visitor-1", role: "demo", ttlSeconds: 3600 }), SECRET);
  return new Request("http://localhost/api/voice/transcribe", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
}

test("the voice route rejects an unauthenticated request before anything else", async () => {
  process.env.EMORI_SESSION_SECRET = SECRET;
  const response = await POST(new Request("http://localhost/api/voice/transcribe", { method: "POST", body: new FormData() }));
  assert.equal(response.status, 401);
});

test("the voice route forwards browser audio to ElevenLabs Scribe v2", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";

  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.elevenlabs.io/v1/speech-to-text");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { "xi-api-key": "test-elevenlabs-key" });

    const body = init?.body;
    assert.ok(body instanceof FormData);
    assert.equal(body.get("model_id"), "scribe_v2");
    assert.equal(body.get("tag_audio_events"), "false");
    assert.equal(body.get("diarize"), "false");
    assert.ok(body.get("file") instanceof File);

    return Response.json({ text: "A remembered summer afternoon." });
  };

  try {
    const formData = new FormData();
    formData.append(
      "file",
      new File(["mock audio"], "recording.webm", { type: "audio/webm" }),
    );

    const response = await POST(authed(formData));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "A remembered summer afternoon." });
  } finally {
    globalThis.fetch = originalFetch;

    if (originalApiKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = originalApiKey;
    }
  }
});

test("an authenticated request reports a missing ElevenLabs key", async () => {
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;

  try {
    const response = await POST(authed(new FormData()));

    assert.equal(response.status, 503);
    assert.match(JSON.stringify(await response.json()), /ELEVENLABS_API_KEY/);
  } finally {
    if (originalApiKey !== undefined) process.env.ELEVENLABS_API_KEY = originalApiKey;
  }
});
