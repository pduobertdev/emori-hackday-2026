// Edge runtime Sentry init. Loaded from instrumentation.ts. No-op without SENTRY_DSN.
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "./lib/sentry/options";

Sentry.init(sentryOptions(process.env.SENTRY_DSN, process.env.SENTRY_TRACES_SAMPLE_RATE));
