import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_FILE = join(process.cwd(), "memorysample.txt");
const IMAGE_DIR = join(process.cwd(), "memory-images");
const MAX_MEMORY_LENGTH = 50_000;

export type ImageScope = { tenantId: string; userId: string };

/** The fictional seed flat file. Only the demo tenant may read it (see the chat route). */
export async function readDurableMemory(): Promise<string> {
  try {
    return (await readFile(MEMORY_FILE, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

// Reject anything that is not a plain path segment, so a tenant or user id can never escape
// the image directory (e.g. "../../etc").
function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Unsafe path segment for the durable image store.");
  }
  return value;
}

function imagePath(scope: ImageScope): string {
  return join(IMAGE_DIR, safeSegment(scope.tenantId), `${safeSegment(scope.userId)}.jpg`);
}

/** The caller's own reference image, or undefined if they have not uploaded one. */
export async function readDurableImage(scope: ImageScope): Promise<Uint8Array | undefined> {
  try {
    return await readFile(imagePath(scope));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeDurableImage(scope: ImageScope, value: Uint8Array): Promise<void> {
  const path = imagePath(scope);
  await mkdir(join(IMAGE_DIR, safeSegment(scope.tenantId)), { recursive: true });
  await writeFile(path, value, { mode: 0o600 });
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
