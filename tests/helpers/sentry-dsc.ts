// Shared by the createDsc tests. Each test FILE runs in its own process, so Sentry.init is called once.
import * as Sentry from "@sentry/nextjs";
import { installPrivacyHooks, sentryOptions } from "../../lib/sentry/options";

/** Real SDK + production options + fake transport; root span with a raw-URL custom name. */
export async function captureWithCustomRootName(installHooks: boolean): Promise<{ all: string; baggage: string }> {
  const envelopes: string[] = [];
  Sentry.init({
    ...sentryOptions("https://publickey@o0.ingest.sentry.io/0", "1", "test"),
    transport: () => ({
      send: async (envelope: unknown) => {
        envelopes.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
  if (installHooks) installPrivacyHooks(Sentry.getClient());
  let baggage = "";
  Sentry.startSpan({ name: "GET /cb?code=OAUTHCODE&email=bob%40ex.com&page=2", op: "http.server" }, () => {
    baggage = String(Sentry.getTraceData().baggage ?? "");
    Sentry.captureException(new Error("dsc test"));
  });
  await Sentry.getClient()?.flush(2000);
  return { all: envelopes.join("\n"), baggage };
}
