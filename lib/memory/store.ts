import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_FILE = join(process.cwd(), "memorysample.txt");
const IMAGE_FILE = join(process.cwd(), "memorysample-image.jpg");
const MAX_MEMORY_LENGTH = 50_000;

export async function readDurableMemory(): Promise<string> {
  try {
    return (await readFile(MEMORY_FILE, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function readDurableImage(): Promise<Uint8Array | undefined> {
  try {
    return await readFile(IMAGE_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeDurableImage(value: Uint8Array): Promise<void> {
  await writeFile(IMAGE_FILE, value, { mode: 0o600 });
}

export async function writeDurableMemory(value: string): Promise<void> {
  const text = value.trim();

  if (!text) {
    throw new Error("Memory text cannot be empty.");
  }

  if (text.length > MAX_MEMORY_LENGTH) {
    throw new Error(`Memory text cannot exceed ${MAX_MEMORY_LENGTH} characters.`);
  }

  await writeFile(MEMORY_FILE, `${text}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
