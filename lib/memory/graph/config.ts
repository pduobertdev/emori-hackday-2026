import type { MemoryGraphConnection } from "./types";

export type MemoryGraphConfig = {
  uri: string;
  username: string;
  password: string;
  database?: string;
};

export function describeMemoryGraphConnection(uri: string): MemoryGraphConnection {
  let hostname = "";
  try {
    hostname = new URL(uri).hostname.toLowerCase();
  } catch {
    return { kind: "remote", label: "Remote Neo4j" };
  }

  if (hostname.endsWith(".databases.neo4j.io")) {
    return {
      kind: "aura",
      label: "Neo4j AuraDB",
      instance: hostname.split(".")[0]?.slice(0, 8),
    };
  }

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return { kind: "local", label: "Local Neo4j" };
  }

  return { kind: "remote", label: "Remote Neo4j" };
}

export type MemoryGraphStatus =
  | { configured: true; config: MemoryGraphConfig }
  | { configured: false; missing: string[] };

export function inspectMemoryGraph(
  env: Record<string, string | undefined> = process.env,
): MemoryGraphStatus {
  const uri = env.NEO4J_URI?.trim();
  const password = env.NEO4J_PASSWORD?.trim();
  const missing: string[] = [];

  if (!uri) missing.push("NEO4J_URI");
  if (!password) missing.push("NEO4J_PASSWORD");
  if (!uri || !password) return { configured: false, missing };

  return {
    configured: true,
    config: {
      uri,
      username: env.NEO4J_USERNAME?.trim() || "neo4j",
      password,
      database: env.NEO4J_DATABASE?.trim() || undefined,
    },
  };
}
