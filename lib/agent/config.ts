export type AgentProvider = "openrouter" | "crusoe";

export type AgentRuntimeConfig = {
  provider: AgentProvider;
  model: string;
  apiKey: string;
  baseURL: string;
  headers: Record<string, string>;
};

export type AgentRuntimeStatus =
  | {
      configured: true;
      provider: AgentProvider;
      model: string;
      baseURL: string;
      config: AgentRuntimeConfig;
    }
  | {
      configured: false;
      provider?: AgentProvider;
      missing: string[];
    };

const providerDefaults: Record<AgentProvider, { baseURL: string; keyName: string }> = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    keyName: "OPENROUTER_API_KEY",
  },
  crusoe: {
    baseURL: "https://api.inference.crusoecloud.com/v1",
    keyName: "CRUSOE_API_KEY",
  },
};

function resolveProvider(env: NodeJS.ProcessEnv): AgentProvider | undefined {
  const requestedProvider = env.AI_PROVIDER?.trim().toLowerCase();

  if (requestedProvider === "openrouter" || requestedProvider === "crusoe") {
    return requestedProvider;
  }

  if (requestedProvider) return undefined;
  if (env.OPENROUTER_API_KEY) return "openrouter";
  if (env.CRUSOE_API_KEY) return "crusoe";
  return undefined;
}

export function inspectAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntimeStatus {
  const provider = resolveProvider(env);
  const missing: string[] = [];

  if (!provider) {
    missing.push("AI_PROVIDER=openrouter|crusoe");
    if (env.AI_PROVIDER) missing.push("a supported AI_PROVIDER value");
  }

  const model = env.AI_MODEL?.trim();
  if (!model) missing.push("AI_MODEL");

  if (!provider) {
    return { configured: false, missing };
  }

  const providerDefaultsForSelection = providerDefaults[provider];
  const apiKey = env[providerDefaultsForSelection.keyName]?.trim();
  if (!apiKey) missing.push(providerDefaultsForSelection.keyName);

  if (!model || !apiKey) {
    return { configured: false, provider, missing };
  }

  const headers: Record<string, string> = {};
  if (provider === "openrouter") {
    headers["X-OpenRouter-Title"] = env.OPENROUTER_APP_NAME?.trim() || "Emori";
    if (env.APP_URL?.trim()) headers["HTTP-Referer"] = env.APP_URL.trim();
  }

  const config: AgentRuntimeConfig = {
    provider,
    model,
    apiKey,
    baseURL: env.AI_BASE_URL?.trim() || providerDefaultsForSelection.baseURL,
    headers,
  };

  return {
    configured: true,
    provider,
    model,
    baseURL: config.baseURL,
    config,
  };
}

export function getAgentRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AgentRuntimeConfig {
  const status = inspectAgentRuntime(env);

  if (!status.configured) {
    throw new Error(`Agent runtime is not configured. Missing: ${status.missing.join(", ")}`);
  }

  return status.config;
}
