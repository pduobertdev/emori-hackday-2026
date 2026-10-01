// Browser Sentry init. No-op without NEXT_PUBLIC_SENTRY_DSN (inlined at build time).
// No Session Replay or user feedback: this app handles personal memories and voice.
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "./lib/sentry/options";

Sentry.init(
  sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN, process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE),
);

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
