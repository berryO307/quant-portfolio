import { redirect } from "next/navigation";

// The order book used to live at "/" itself — moved to its own dedicated
// "/orderbook" route (matching "/architecture") so the URL bar reads the
// same way for every page instead of one of them being the bare root.
export default function Page() {
  redirect("/orderbook");
}
