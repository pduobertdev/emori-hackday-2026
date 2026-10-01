// Shared Sentry.init options for client, server and edge. Privacy first, quota friendly.
import type { BrowserOptions, NodeOptions } from "@sentry/nextjs";
import { safeBeforeBreadcrumb, safeBeforeSend, scrubDsc, scrubStreamedSpan } from "./scrub";

type HookableClient = { on(hook: "createDsc", callback: (dsc: Record<string, unknown>) => void): unknown };

/**
 * Call right after Sentry.init: scrubs the DSC (envelope `trace` header / baggage), which no before*
 * hook covers. Defense in depth only: span (beforeSendSpan) and event (beforeSend) scrubbing remain the
 * primary protection; the DSC only carries the root span name, which Next.js sets to the route.
 */
export function installPrivacyHooks(client: HookableClient | undefined): void {
  client?.on("createDsc", scrubDsc);
}

/** 5% of requests traced by default; override with SENTRY_TRACES_SAMPLE_RATE / NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE. */
export function tracesSampleRate(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05;
}

/**
 * @param dsn Sentry DSN from the environment. Empty/undefined means Sentry is fully disabled.
 * @param environment Deploy environment (VERCEL_ENV on the server, NEXT_PUBLIC_VERCEL_ENV in the browser).
 *
 * @sentry/nextjs v11 removed `sendDefaultPii`; its replacement is `dataCollection`. Everything that
 * sendDefaultPii=false used to keep out (user identity/IP, cookies, request bodies, query values)
 * is turned off here, plus gen-AI prompts/outputs, DB params and stack-frame local variables.
 */
export function sentryOptions(dsn: string | undefined, rawRate: string | undefined, environment?: string) {
  const enabled = typeof dsn === "string" && dsn.trim() !== "";
  return {
    dsn: enabled ? dsn : undefined,
    enabled,
    environment: environment || process.env.NODE_ENV,
    tracesSampleRate: tracesSampleRate(rawRate),
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: {
          deny: [
            "authorization",
            "proxy-authorization",
            "cookie",
            "set-cookie",
            "x-api-key",
            "x-csrf-token",
            "x-xsrf-token",
            // IP-bearing headers (sendDefaultPii=false never sent the client IP)
            "x-forwarded-for",
            "x-real-ip",
            "forwarded",
            "true-client-ip",
            "cf-connecting-ip",
            "x-client-ip",
            "x-vercel-forwarded-for",
            "x-vercel-proxied-for",
          ],
        },
        response: false,
      },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // v11 streams spans by default (`traceLifecycle: 'stream'`), which IGNORES beforeSendTransaction.
    // We keep streaming (the SDK's default and future path; beforeSendTransaction is removed in v12)
    // and scrub every span with beforeSendSpan instead. Pinned explicitly so the hook always matches.
    traceLifecycle: "stream",
    beforeSend: (event) => safeBeforeSend(event),
    beforeSendSpan: (span) => scrubStreamedSpan(span),
    beforeBreadcrumb: (breadcrumb) => safeBeforeBreadcrumb(breadcrumb),
  } satisfies BrowserOptions & NodeOptions;
}
