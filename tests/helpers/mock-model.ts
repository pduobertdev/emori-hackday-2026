import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntimeConfig } from "../../lib/agent/config";

type Reply = string | ((requestBody: string) => string);

/** A tiny OpenAI-compatible chat server so agent code can be tested without a real model. */
export async function startMockModel() {
  let reply: Reply = "{}";
  let status = 200;
  let lastBody = "";

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      lastBody = body;
      const content = typeof reply === "function" ? reply(body) : reply;

      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        status === 200
          ? JSON.stringify({
              id: "mock-1",
              object: "chat.completion",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          : JSON.stringify({ error: { message: "mock failure" } }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const runtime: AgentRuntimeConfig = {
    provider: "openrouter",
    model: "test-model",
    apiKey: "test-key",
    baseURL,
    headers: {},
  };

  return {
    runtime,
    baseURL,
    reply(next: Reply) {
      reply = next;
      status = 200;
    },
    fail() {
      status = 500;
    },
    lastBody: () => lastBody,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
