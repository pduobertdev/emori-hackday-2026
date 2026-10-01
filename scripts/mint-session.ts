import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createSession, getSessionSecret, signSession } from "../lib/auth/session";

/** Read a `--name value` flag from argv. */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function main() {
  const tenantId = flag("tenant");
  const userId = flag("user");
  const ttlSeconds = Number(flag("ttl") ?? DEFAULT_TTL_SECONDS);

  if (!tenantId || !userId) {
    console.error("Usage: npm run session:mint -- --tenant <tenantId> --user <userId> [--ttl <seconds>]");
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    console.error("--ttl must be a positive number of seconds.");
    process.exitCode = 1;
    return;
  }

  const secret = getSessionSecret();
  if (!secret) {
    console.error("Set EMORI_SESSION_SECRET (at least 32 characters) in .env.local first.");
    process.exitCode = 1;
    return;
  }

  const token = signSession(createSession({ tenantId, userId, role: "member", ttlSeconds }), secret);

  console.log(token);
  console.error(`\nMember session for tenant "${tenantId}" user "${userId}", valid ${ttlSeconds}s.`);
  console.error("Use it as:  Authorization: Bearer <token>   or cookie emori_session=<token>");
}

main();
