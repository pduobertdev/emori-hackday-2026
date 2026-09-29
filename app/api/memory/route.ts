import { readDurableMemory, writeDurableMemory } from "@/lib/memory/store";

export const runtime = "nodejs";

export async function GET() {
  const text = await readDurableMemory();
  return Response.json({ text });
}

export async function PUT(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const text =
    payload && typeof payload === "object" && "text" in payload
      ? (payload as { text?: unknown }).text
      : undefined;

  if (typeof text !== "string") {
    return Response.json({ error: "Send a text string." }, { status: 400 });
  }

  try {
    await writeDurableMemory(text);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The memory could not be saved." },
      { status: 400 },
    );
  }

  return Response.json({ saved: true });
}
