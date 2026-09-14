"use client";

import { useTheme } from "@/lib/useTheme";

// Same segmented-button pattern as DepthCurve's TimeframeToggle and
// SessionStatsHeader's WindowToggle — active option highlighted with
// bg-primary, matching every other two-way toggle already in this app.
export function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <div className="flex overflow-hidden rounded border border-border text-[10px]" title="Light / dark mode">
      <button
        type="button"
        onClick={() => theme !== "light" && toggle()}
        className={`px-1.5 py-0.5 ${theme === "light" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
      >
        Light
      </button>
      <button
        type="button"
        onClick={() => theme !== "dark" && toggle()}
        className={`px-1.5 py-0.5 ${theme === "dark" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
      >
        Dark
      </button>
    </div>
  );
}
