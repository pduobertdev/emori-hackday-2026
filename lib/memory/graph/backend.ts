import * as repository from "./repository";

/**
 * The slice of the repository the API routes and service depend on. Routes call through
 * `memoryBackend()` instead of importing the repository directly, so a test can swap in an
 * in-memory fake that honours the same tenant/owner scoping contract without a real Neo4j.
 */
export type MemoryBackend = {
  saveMemory: typeof repository.saveMemory;
  listMemories: typeof repository.listMemories;
  recallMemories: typeof repository.recallMemories;
  memoriesForQuestion: typeof repository.memoriesForQuestion;
  getMemoryGraph: typeof repository.getMemoryGraph;
  deleteMemory: typeof repository.deleteMemory;
};

const real: MemoryBackend = repository;
let current: MemoryBackend = real;

export function memoryBackend(): MemoryBackend {
  return current;
}

/** Test-only: replace some or all backend functions with a fake. */
export function setMemoryBackendForTests(fake: Partial<MemoryBackend>): void {
  current = { ...real, ...fake };
}

/** Test-only: restore the real repository backend. */
export function resetMemoryBackendForTests(): void {
  current = real;
}
