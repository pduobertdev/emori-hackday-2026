// Privacy scrubber for Sentry events (beforeSend / beforeSendTransaction / beforeBreadcrumb).
// Shared by the client, server and edge configs. No runtime Sentry import, so it's unit-testable with tsx.
//
// Defense in depth on top of the privacy-first `dataCollection` options in ./options.ts:
// - Emails anywhere in free text become "[email]".
// - Values under sensitive keys (email, email_hash, token, password, cookie, authorization,
//   secret, api key, signature...) become "[Filtered]".
// - Cookies are dropped. Authorization / Cookie / CSRF / signature headers are filtered.
// - Request bodies are dropped ENTIRELY on auth routes (login, register, password, oauth,
//   sanctum/token), billing routes (stripe, webhook, checkout, subscription) and the app's
//   personal-content routes (memory, chat, voice).
// - Bearer tokens, JWTs, provider API keys (sk-, sk_live_, whsec_...) and `token=...`
//   pairs in free text are redacted.
// - User context keeps only the id.

import type { Breadcrumb, Event } from "@sentry/nextjs";

export const FILTERED = "[Filtered]";
export const EMAIL_PLACEHOLDER = "[email]";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

const SENSITIVE_KEY_PATTERN =
  /e[-_]?mail|token|passw|pwd|secret|cookie|authori[sz]ation|^auth$|api[-_]?key|private[-_]?key|session|csrf|xsrf|signature|^otp$|verification[-_]?code|card[-_]?number|^cvc$|^cvv$|^dsn$|^code$|^state$/i;

const SENSITIVE_PATH_PATTERN = new RegExp(
  "(^|/)(" +
    "login|logout|register|password|forgot-password|reset-password|oauth|auth|sanctum|token|web-token|auto-login" +
    "|stripe|webhook|webhooks|checkout|billing|subscription|subscriptions|plan-upgrade" +
    "|memory|chat|voice" +
    ")(/|$|\\?|-)",
  "i",
);

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=|-]+/gi, `$1 ${FILTERED}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, FILTERED],
  [/\b\d+\|[A-Za-z0-9]{40,}\b/g, FILTERED],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+\b/g, FILTERED],
  [/\bwhsec_[A-Za-z0-9]+\b/g, FILTERED],
  // OpenAI/OpenRouter-style keys: sk-..., sk-or-v1-...
  [/\bsk-[A-Za-z0-9_-]{16,}/g, FILTERED],
  [
    /\b([A-Za-z_-]*(?:token|password|secret|api[_-]?key|email_hash)[A-Za-z_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi,
    `$1$2${FILTERED}`,
  ],
];

const URL_TOKEN_PATTERN = /\/(reset-password|auto-login|verify-email|magic-link|invite)\/[^/?#{][^/?#]*/gi;

type Json = unknown;

export function isSensitiveKey(key: string | number): boolean {
  return typeof key === "string" && SENSITIVE_KEY_PATTERN.test(key);
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERN.test(path);
}

export function scrubString(value: string): string {
  let out = value.replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER);
  for (const [pattern, replacement] of TOKEN_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function scrubValue(value: Json, depth = 0): Json {
  if (depth > 10) return FILTERED;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      out[k] = isSensitiveKey(k) ? FILTERED : scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function scrubQueryString(query: string): string {
  if (!query) return query;
  const [q, ...hash] = query.split("#");
  const parts = q.split("&").map((pair) => {
    const [key] = pair.split("=", 1);
    let decodedKey = key;
    try {
      decodedKey = decodeURIComponent(key);
    } catch {
      /* keep raw key */
    }
    return isSensitiveKey(decodedKey) ? `${key}=${FILTERED}` : scrubString(pair);
  });
  return parts.join("&") + (hash.length ? `#${hash.join("#")}` : "");
}

export function scrubUrl(url: string): string {
  let out = url.replace(URL_TOKEN_PATTERN, `/$1/${FILTERED}`);
  const i = out.indexOf("?");
  if (i !== -1) out = out.slice(0, i + 1) + scrubQueryString(out.slice(i + 1));
  return scrubString(out);
}

function pathOf(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url;
  }
}

type SentryRequest = NonNullable<Event["request"]>;

export function scrubRequest(request: SentryRequest): SentryRequest {
  const out: SentryRequest = { ...request };
  delete out.cookies;

  if (typeof out.url === "string" && isSensitivePath(pathOf(out.url))) {
    delete out.data;
  } else if (out.data !== undefined) {
    out.data = scrubValue(out.data);
  }

  if (out.headers) out.headers = scrubValue(out.headers) as SentryRequest["headers"];
  if (typeof out.url === "string") out.url = scrubUrl(out.url);
  if (typeof out.query_string === "string") out.query_string = scrubQueryString(out.query_string);
  else if (out.query_string) out.query_string = scrubValue(out.query_string) as SentryRequest["query_string"];
  if (out.env) out.env = scrubValue(out.env) as SentryRequest["env"];
  return out;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const out: Breadcrumb = { ...breadcrumb };
  if (typeof out.message === "string") out.message = scrubString(out.message);
  if (out.data) {
    const data = scrubValue(out.data) as Record<string, unknown>;
    if (typeof data.url === "string") data.url = scrubUrl(data.url);
    out.data = data;
  }
  return out;
}

/** Scrubs an event in place and returns it. Never drops events. */
export function scrubEvent<T extends Event>(event: T): T {
  if (event.request) event.request = scrubRequest(event.request);
  if (typeof event.message === "string") event.message = scrubString(event.message);
  if (typeof event.transaction === "string") event.transaction = scrubUrl(event.transaction);

  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === "string") ex.value = scrubString(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (frame.vars) frame.vars = scrubValue(frame.vars) as typeof frame.vars;
    }
  }

  if (event.extra) event.extra = scrubValue(event.extra) as T["extra"];
  if (event.tags) event.tags = scrubValue(event.tags) as T["tags"];
  if (event.contexts) event.contexts = scrubValue(event.contexts) as T["contexts"];
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  if (event.user) event.user = event.user.id !== undefined ? { id: event.user.id } : {};

  for (const span of event.spans ?? []) {
    if (typeof span.description === "string") span.description = scrubUrl(span.description);
    if (span.data) span.data = scrubValue(span.data) as typeof span.data;
  }

  return event;
}
