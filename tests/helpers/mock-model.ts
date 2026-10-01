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

      if (status !== 200) {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "mock failure" } }));
        return;
      }

      // Streaming callers (e.g. the chat route) get Server-Sent Events; everyone else a single
      // JSON completion. Detecting `"stream":true` keeps both shapes working from one server.
      if (/"stream"\s*:\s*true/.test(body)) {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        const event = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
        event({
          id: "mock-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
        });
        event({
          id: "mock-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "mock-1",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
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
