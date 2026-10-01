// Server (Node.js runtime) Sentry init. Loaded from instrumentation.ts. No-op without SENTRY_DSN.
import * as Sentry from "@sentry/nextjs";
import { installPrivacyHooks, sentryOptions } from "./lib/sentry/options";

Sentry.init(sentryOptions(process.env.SENTRY_DSN, process.env.SENTRY_TRACES_SAMPLE_RATE, process.env.VERCEL_ENV));
installPrivacyHooks(Sentry.getClient());
