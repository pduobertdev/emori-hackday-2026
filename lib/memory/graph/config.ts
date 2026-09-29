export type MemoryGraphConfig = {
  uri: string;
  username: string;
  password: string;
  database?: string;
};

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
