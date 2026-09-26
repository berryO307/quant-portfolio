import type { Metadata } from "next";

import { ArchitectureView } from "@/components/architecture/ArchitectureView";

export const metadata: Metadata = {
  title: "System Architecture",
  description:
    "How the L2 market data gateway fits together: Hyperliquid → C++ gateway → Node relay → Next.js viewer.",
};

// Static and presentational — nothing on this page talks to the relay.
export default function ArchitecturePage() {
  return <ArchitectureView />;
}
