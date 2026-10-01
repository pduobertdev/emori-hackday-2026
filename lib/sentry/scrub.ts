// Privacy scrubber for Sentry events and spans (beforeSend / beforeSendSpan / beforeBreadcrumb).
// Shared by the client, server and edge configs. No runtime Sentry import, so it's unit-testable with tsx.
//
// Defense in depth on top of the privacy-first `dataCollection` options in ./options.ts:
// - Emails anywhere in free text become "[email]".
// - Values under sensitive keys (email, email_hash, token, password, cookie, authorization,
//   secret, api key, signature...) become "[Filtered]".
// - Cookies are dropped. Authorization / Cookie / CSRF / signature headers are filtered.
// - Request bodies are dropped ENTIRELY on every route. The query string is dropped too on auth
//   routes (login, register, password, oauth, sanctum/token), billing routes (stripe, webhook,
//   checkout, subscription) and the app's personal-content routes (memory, chat, voice).
// - Bearer tokens, JWTs, provider API keys (sk-, sk_live_, whsec_...) and `token=...`
//   pairs in free text are redacted.
// - IP-bearing headers (x-forwarded-for, x-real-ip, forwarded, cf-connecting-ip...) are filtered
//   and request.env (REMOTE_ADDR) is dropped.
// - User context keeps only the id.
// - Streamed spans (v11 default `traceLifecycle: 'stream'`, which ignores beforeSendTransaction)
//   go through `scrubStreamedSpan` via `beforeSendSpan`: name + every string attribute.
// - Strings are percent-decoded before matching, so `bob%40ex.com` and encoded queries are caught.
// - URL-like values (url, *.url, *path, *route, *target, request_path...) go through scrubUrl, so
//   raw query strings lose sensitive params (email, token, OAuth code/state...).

import type { Breadcrumb, Event, NodeOptions } from "@sentry/nextjs";

/** The v11 streamed span payload passed to `beforeSendSpan` (derived so we don't import @sentry/core). */
export type StreamedSpanJSON = Parameters<NonNullable<NodeOptions["beforeSendSpan"]>>[0];

export const FILTERED = "[Filtered]";
export const EMAIL_PLACEHOLDER = "[email]";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

const SENSITIVE_KEY_PATTERN =
  /e[-_]?mail|token|passw|pwd|secret|cookie|authori[sz]ation|^auth$|api[-_]?key|private[-_]?key|session|csrf|xsrf|signature|^otp$|verification[-_]?code|card[-_]?number|^cvc$|^cvv$|^dsn$|forwarded|real[-_]?ip|client[-_]?ip|connecting[-_]?ip|remote[-_]?addr|ip[-_]?address|^ip$/i;

// OAuth `code` / `state` are only secret as URL query params; as object keys they're usually
// harmless debugging data (e.g. { code: "ECONNREFUSED" }), so they're filtered in query strings only.
const SENSITIVE_QUERY_KEY_PATTERN = /^(code|state)$/i;

const SENSITIVE_PATH_PATTERN = new RegExp(
  "(^|/)(" +
    "login|logout|register|password|forgot-password|reset-password|oauth|auth|sanctum|token|web-token|auto-login" +
    "|stripe|webhook|webhooks|checkout|billing|subscription|subscriptions|plan-upgrade" +
    "|memory|chat|voice" +
    ")(/|$|\\?|-)",
  "i",
);

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  // OpenRouter keys (sk-or-v1-...) and ElevenLabs keys (sk_ + 32+ chars)
  [/\bsk-or-v1-[A-Za-z0-9]{16,}\b/g, FILTERED],
  [/\bsk_[A-Za-z0-9]{32,}\b/g, FILTERED],
  // Sensitive params inside raw query strings/URLs embedded in free text: ?code=..&state=..&email=..
  [/([?&;])((?:code|state|e-?mail|otp)=)[^&#\s]*/gi, `$1$2${FILTERED}`],
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

/** Keys whose string value is a URL/path (scrubbed with scrubUrl). */
const URL_KEY_PATTERN = /(^|[._-])(url|uri|href|path|target|route|referr?er|location|request_path)$|^url([._]|$)/i;
/** Keys whose string value is a bare query string. */
const QUERY_KEY_PATTERN = /(^|[._-])query(_string)?$/i;

/**
 * Percent-decodes a string so encoded emails/params are matched. Malformed encodings never throw:
 * each run of %XX sequences is decoded on its own and left as-is if it isn't valid UTF-8.
 */
export function safeDecode(value: string): string {
  // Up to 3 passes so double/triple-encoded values (%2540) are caught too.
  let out = value;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function decodeOnce(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/** Scrubs a string value according to its key: URL-ish keys via scrubUrl, query keys via scrubQueryString. */
export function scrubKeyedString(key: string, value: string): string {
  if (QUERY_KEY_PATTERN.test(key)) return scrubQueryString(value.replace(/^\?/, ""));
  if (URL_KEY_PATTERN.test(key)) return scrubUrl(value);
  return scrubString(value);
}

export function isSensitiveKey(key: string | number): boolean {
  return typeof key === "string" && SENSITIVE_KEY_PATTERN.test(key);
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERN.test(path);
}

export function scrubString(value: string): string {
  let out = safeDecode(value).replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER);
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
      out[k] = isSensitiveKey(k) ? FILTERED : typeof v === "string" ? scrubKeyedString(k, v) : scrubValue(v, depth + 1);
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
    return isSensitiveKey(decodedKey) || SENSITIVE_QUERY_KEY_PATTERN.test(decodedKey)
      ? `${key}=${FILTERED}`
      : scrubString(pair);
  });
  return parts.join("&") + (hash.length ? `#${hash.join("#")}` : "");
}

export function scrubUrl(url: string): string {
  let out = safeDecode(url).replace(URL_TOKEN_PATTERN, `/$1/${FILTERED}`);
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

  // Request bodies never leave the server, on ANY route.
  delete out.data;

  if (typeof out.url === "string" && isSensitivePath(pathOf(out.url))) {
    // Also drop the query string on auth/billing/personal-content routes.
    delete out.query_string;
    const q = out.url.indexOf("?");
    if (q !== -1) out.url = out.url.slice(0, q);
  }

  if (out.headers) out.headers = scrubValue(out.headers) as SentryRequest["headers"];
  if (typeof out.url === "string") out.url = scrubUrl(out.url);
  if (typeof out.query_string === "string") out.query_string = scrubQueryString(out.query_string);
  else if (out.query_string) out.query_string = scrubValue(out.query_string) as SentryRequest["query_string"];
  // Server env (REMOTE_ADDR etc.) is never useful enough to justify the IP leak risk.
  delete out.env;
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

type SpanAttributes = StreamedSpanJSON["attributes"];

function scrubAttributeValue(key: string, value: unknown): unknown {
  if (typeof value === "string") return isSensitiveKey(key) ? FILTERED : scrubKeyedString(key, value);
  if (Array.isArray(value)) {
    if (isSensitiveKey(key)) return value.map((v) => (typeof v === "string" ? FILTERED : v));
    return value.map((v) => (typeof v === "string" ? scrubKeyedString(key, v) : v));
  }
  // Typed attribute objects: { value, type, unit? }
  if (value && typeof value === "object" && "value" in value) {
    const obj = value as { value: unknown };
    return { ...obj, value: scrubAttributeValue(key, obj.value) };
  }
  return value;
}

export function scrubSpanAttributes<T extends SpanAttributes | undefined>(attributes: T): T {
  if (!attributes) return attributes;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) out[key] = scrubAttributeValue(key, value);
  return out as T;
}

/**
 * `beforeSendSpan` hook for streamed spans (the v11 default). Scrubs the span name (it can contain
 * the raw URL), every string attribute (http.target, url.*, sentry.status.message, headers...)
 * and span-link attributes. Never drops spans.
 */
export function scrubStreamedSpan(span: StreamedSpanJSON): StreamedSpanJSON {
  span.name = scrubUrl(span.name);
  span.attributes = scrubSpanAttributes(span.attributes);
  if (span.links) {
    span.links = span.links.map((link) => ({ ...link, attributes: scrubSpanAttributes(link.attributes) }));
  }
  return span;
}

/**
 * Scrubs the dynamic sampling context (envelope header `trace` + outgoing `baggage`), whose
 * `transaction` is the raw root span name. Mutates in place (the SDK's `createDsc` hook contract).
 */
export function scrubDsc(dsc: Record<string, unknown>): void {
  if (typeof dsc.transaction === "string") dsc.transaction = scrubUrl(dsc.transaction);
}

/** Scrubs an event in place and returns it. Never drops events. */
export function scrubEvent<T extends Event>(event: T): T {
  if (event.request) event.request = scrubRequest(event.request);
  if (typeof event.message === "string") event.message = scrubString(event.message);
  if (event.logentry) {
    if (typeof event.logentry.message === "string") event.logentry.message = scrubString(event.logentry.message);
    if (event.logentry.params) event.logentry.params = scrubValue(event.logentry.params) as unknown[];
  }
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
