// Shared Sentry.init options for client, server and edge. Privacy first, quota friendly.
import type { BrowserOptions, NodeOptions } from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "./scrub";

/** 5% of requests traced by default; override with SENTRY_TRACES_SAMPLE_RATE / NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE. */
export function tracesSampleRate(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05;
}

/**
 * @param dsn Sentry DSN from the environment. Empty/undefined means Sentry is fully disabled.
 *
 * @sentry/nextjs v11 removed `sendDefaultPii`; its replacement is `dataCollection`. Everything that
 * sendDefaultPii=false used to keep out (user identity/IP, cookies, request bodies, query values)
 * is turned off here, plus gen-AI prompts/outputs, DB params and stack-frame local variables.
 */
export function sentryOptions(dsn: string | undefined, rawRate: string | undefined) {
  const enabled = typeof dsn === "string" && dsn.trim() !== "";
  return {
    dsn: enabled ? dsn : undefined,
    enabled,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: tracesSampleRate(rawRate),
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { deny: ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-csrf-token", "x-xsrf-token"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  } satisfies BrowserOptions & NodeOptions;
}
