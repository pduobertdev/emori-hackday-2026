/**
 * HARD PAUSE: "Demo coming soon".
 *
 * This proxy runs before every route. It answers every request itself, so no page renders and no
 * API route handler runs. That means the Neo4j driver, the OpenRouter/Crusoe client and the
 * ElevenLabs call are never created or reached. Their env vars stay configured but go unused.
 *
 * - /api/* → 503 JSON
 * - everything else → 503 HTML page whose only text is "Demo coming soon"
 *
 * There's no flag or env switch on purpose. To un-pause, revert the commit that added this file.
 */

const RETRY_AFTER_SECONDS = "86400";

export const PAUSE_TEXT = "Demo coming soon";

export const PAUSE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${PAUSE_TEXT}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#0f0d17;color:#f4f1ff;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;text-align:center}
  h1{font-size:clamp(32px,6vw,56px);font-weight:600;margin:0;padding:32px}
</style>
</head>
<body>
<h1>${PAUSE_TEXT}</h1>
</body>
</html>`;

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "Retry-After": RETRY_AFTER_SECONDS,
  "X-Robots-Tag": "noindex",
};

export function proxy(request: Request): Response {
  const { pathname } = new URL(request.url);

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    if (request.method === "HEAD") return new Response(null, { status: 503, headers: COMMON_HEADERS });
    return Response.json({ error: PAUSE_TEXT, paused: true }, { status: 503, headers: COMMON_HEADERS });
  }

  return new Response(request.method === "HEAD" ? null : PAUSE_HTML, {
    status: 503,
    headers: { ...COMMON_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

// Match every path, including /api and Next internals, so nothing gets past the pause.
export const config = {
  matcher: "/:path*",
};
