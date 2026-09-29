import neo4j, { type Driver, type ManagedTransaction } from "neo4j-driver";
import { inspectMemoryGraph, type MemoryGraphConfig } from "./config";

type Holder = { driver: Driver; fingerprint: string; ready?: Promise<void> };

// Kept on globalThis so Next.js dev reloads and warm serverless invocations reuse one driver.
const globalStore = globalThis as typeof globalThis & { __emoriMemoryGraph?: Holder };

const SCHEMA = [
  "CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE",
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

async function ensureSchema(holder: Holder, config: MemoryGraphConfig) {
  holder.ready ??= (async () => {
    const session = holder.driver.session({ database: config.database });
    try {
      for (const statement of SCHEMA) await session.run(statement);
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
