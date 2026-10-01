import neo4j, { type Driver, type ManagedTransaction } from "neo4j-driver";
import { inspectMemoryGraph, type MemoryGraphConfig } from "./config";

type Holder = { driver: Driver; fingerprint: string; ready?: Promise<void> };

// Kept on globalThis so Next.js dev reloads and warm serverless invocations reuse one driver.
const globalStore = globalThis as typeof globalThis & { __emoriMemoryGraph?: Holder };

const SCHEMA = [
  // A Person is identified by (tenantId, id), so the same logical id (e.g. "leo") can exist in
  // different tenants without collision. The old single-property uniqueness on p.id would forbid
  // that, so it is dropped. A composite uniqueness constraint is Enterprise-only (fine on Aura,
  // unavailable on the local community image), so identity is enforced by MERGE keying on both
  // properties and backed by a plain composite index, which community supports.
  "DROP CONSTRAINT person_id IF EXISTS",
  "CREATE INDEX person_tenant_id IF NOT EXISTS FOR (p:Person) ON (p.tenantId, p.id)",
  "CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE",
  "CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (e:Entity) REQUIRE e.key IS UNIQUE",
  // standard-folding matches "Lucia" against "Lucía".
  "CREATE FULLTEXT INDEX memory_text IF NOT EXISTS FOR (m:Memory) ON EACH [m.text] " +
    "OPTIONS { indexConfig: { `fulltext.analyzer`: 'standard-folding' } }",
];

export function requireMemoryGraphConfig(): MemoryGraphConfig {
  const status = inspectMemoryGraph();
  if (!status.configured) {
    throw new Error(`The memory graph is not configured. Missing: ${status.missing.join(", ")}`);
  }
  return status.config;
}

function holderFor(config: MemoryGraphConfig): Holder {
  const fingerprint = [config.uri, config.username, config.password, config.database ?? ""].join("|");
  const existing = globalStore.__emoriMemoryGraph;
  if (existing?.fingerprint === fingerprint) return existing;

  void existing?.driver.close();
  const holder: Holder = {
    driver: neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
      connectionTimeout: 5_000,
      maxTransactionRetryTime: 5_000,
    }),
    fingerprint,
  };
  globalStore.__emoriMemoryGraph = holder;
  return holder;
}

// Two cold starts (serverless invocations, or parallel test files) can create the schema at the
// same time. `IF NOT EXISTS` is not atomic across sessions, so the loser sees an "equivalent rule
// already exists" error — harmless, the rule it wanted is there — or a transient lock/deadlock,
// which just needs a retry. Both mean the schema is converging, not broken.
const code = (error: unknown): string =>
  (error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "");

async function runSchemaStatement(session: ReturnType<Driver["session"]>, statement: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await session.run(statement);
      return;
    } catch (error) {
      const c = code(error);
      if (c.includes("EquivalentSchemaRuleAlreadyExists")) return;
      if (attempt < 5 && (c.includes("Transient") || c.includes("DeadlockDetected") || c.includes("LockClient"))) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

async function ensureSchema(holder: Holder, config: MemoryGraphConfig) {
  holder.ready ??= (async () => {
    const session = holder.driver.session({ database: config.database });
    try {
      for (const statement of SCHEMA) await runSchemaStatement(session, statement);
    } finally {
      await session.close();
    }
  })().catch((error) => {
    holder.ready = undefined; // let the next request retry
    throw error;
  });

  await holder.ready;
}

async function open(config: MemoryGraphConfig, mode: "read" | "write") {
  const holder = holderFor(config);
  await ensureSchema(holder, config);

  return holder.driver.session({
    database: config.database,
    defaultAccessMode: mode === "read" ? neo4j.session.READ : neo4j.session.WRITE,
  });
}

export async function readGraph<T>(
  work: (tx: ManagedTransaction) => Promise<T>,
  config: MemoryGraphConfig = requireMemoryGraphConfig(),
): Promise<T> {
  const session = await open(config, "read");
  try {
    return await session.executeRead(work);
  } finally {
    await session.close();
  }
}

export async function writeGraph<T>(
  work: (tx: ManagedTransaction) => Promise<T>,
  config: MemoryGraphConfig = requireMemoryGraphConfig(),
): Promise<T> {
  const session = await open(config, "write");
  try {
    return await session.executeWrite(work);
  } finally {
    await session.close();
  }
}

export async function closeMemoryGraph(): Promise<void> {
  const holder = globalStore.__emoriMemoryGraph;
  globalStore.__emoriMemoryGraph = undefined;
  await holder?.driver.close();
}

export { neo4j };
