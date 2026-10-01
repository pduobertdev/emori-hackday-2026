import assert from "node:assert/strict";
import { test } from "node:test";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { PAUSE_HTML, PAUSE_TEXT, config, proxy } from "../proxy";

const base = "https://emori-hackday-2026.vercel.app";

test("every API route is answered with 503 by the proxy (handlers never run)", async () => {
  for (const path of [
    "/api/chat",
    "/api/memory",
    "/api/memory/graph",
    "/api/memory/ask",
    "/api/memory/propose",
    "/api/memory/entries",
    "/api/memory/entries/abc",
    "/api/memory/image",
    "/api/voice/transcribe",
    "/api",
  ]) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const response = proxy(new Request(base + path, { method }));
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = (await response.json()) as { paused?: boolean };
      assert.equal(body.paused, true);
    }
  }
});

test("every page shows the Demo coming soon page", async () => {
  for (const path of ["/", "/memory", "/anything/else", "/apiary"]) {
    const response = proxy(new Request(base + path));
    assert.equal(response.status, 503, path);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.equal(html, PAUSE_HTML);
    // The only visible text on the page is exactly "Demo coming soon".
    const visible = html.replace(/<head>[\s\S]*<\/head>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.equal(visible, "Demo coming soon");
  }
});

test("Next routes every path through the proxy (matcher wiring)", () => {
  assert.equal(config.matcher, "/:path*");
  for (const path of ["/", "/memory", "/api/chat", "/api/memory/graph", "/api/voice/transcribe", "/_next/static/x.js"]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: path }), true, path);
  }
});

test("API 503 body uses the same text, HEAD has no body", async () => {
  const response = proxy(new Request(base + "/api/chat"));
  assert.deepEqual(await response.json(), { error: PAUSE_TEXT, paused: true });
  const head = proxy(new Request(base + "/api/chat", { method: "HEAD" }));
  assert.equal(head.status, 503);
  assert.equal(await head.text(), "");
});

test("the pause page loads nothing from outside", () => {
  assert.doesNotMatch(PAUSE_HTML, /<script|<link|src=|https?:\/\//i);
});
