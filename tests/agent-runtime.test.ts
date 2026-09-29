import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createMateoAgent } from "../lib/agent/mateo";

let server: ReturnType<typeof createServer>;
let baseURL = "";
let receivedBody = "";

before(async () => {
  server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      response.end(
        [
          'data: {"id":"mock-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello from Mateo."},"finish_reason":null}]}',
          'data: {"id":"mock-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("the Mateo agent streams through an OpenAI-compatible endpoint", async () => {
  const agent = createMateoAgent({
    provider: "openrouter",
    model: "test-model",
    apiKey: "test-key",
    baseURL,
    headers: {},
  });

  const result = await agent.stream({ prompt: "Hello" });
  let reply = "";

  for await (const chunk of result.textStream) reply += chunk;

  const requestBody = JSON.parse(receivedBody) as {
    model: string;
    max_tokens: number;
    messages: Array<{ content: string }>;
  };

  assert.equal(reply, "Hello from Mateo.");
  assert.equal(requestBody.model, "test-model");
  assert.equal(requestBody.max_tokens, 1024);
  assert.equal(requestBody.messages.at(-1)?.content, "Hello");
});
