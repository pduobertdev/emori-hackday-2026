import { loadEnvConfig } from "@next/env";
import { createMateoAgent } from "../lib/agent/mateo";

loadEnvConfig(process.cwd());

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();

  if (!prompt) {
    console.error('Usage: npm run agent -- "Your message to Mateo"');
    process.exitCode = 1;
    return;
  }

  try {
    const agent = createMateoAgent();
    const result = await agent.stream({ prompt });

    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }

    process.stdout.write("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent could not start.";
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
