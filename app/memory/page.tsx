import type { Metadata } from "next";
import { MemoryGraphView } from "@/components/memory-graph";

export const metadata: Metadata = {
  title: "Memory graph — Emori",
  description: "See how Emori’s memories connect.",
};

export default function MemoryGraphPage() {
  return <MemoryGraphView />;
}
