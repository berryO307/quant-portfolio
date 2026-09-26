import type { Metadata } from "next";

import { Dashboard } from "@/components/Dashboard";

export const metadata: Metadata = {
  title: "L2 OrderBook",
};

export default function Page() {
  return <Dashboard />;
}
