import { MemoryStage } from "@/components/memory-stage";

// Reached by client-side navigation from the memory tab: /memory opens over the conversation
// instead of replacing it. A refresh or a shared link gets the standalone app/memory page.
export default function ExpandedMemoryPage() {
  return <MemoryStage />;
}
