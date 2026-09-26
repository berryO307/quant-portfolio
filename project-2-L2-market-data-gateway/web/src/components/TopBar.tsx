"use client";

import { useEffect, useState } from "react";

import { Microtape } from "./Microtape";
import { useTheme } from "@/lib/useTheme";
import { useSidebarState } from "@/lib/sidebarState";

/*
 * App-shell top bar. Presentational only — the Light/Dark control is wired
 * to the project's existing theme system (lib/useTheme.ts: the `dark` class
 * on <html> plus the localStorage key app/layout.tsx's no-FOUC script
 * reads). No new theming was invented.
 *
 * The instrument selector deliberately does NOT live here — it stays inline
 * with the Order Book / Trades tabs in the dashboard.
 */

/*
 * Live wall-clock, read from the VIEWER's own browser — new Date() and
 * toLocaleDateString/toLocaleTimeString called with no locale/timeZone
 * argument, so both the calendar format and the time itself come from
 * whatever the browser's own locale/OS clock/timezone say, not a fixed
 * value baked in here.
 *
 * Ticks locally every second rather than depending on any relay/server
 * message — this has nothing to do with feed data.
 */
function Clock() {
  // null until the first client-side effect runs: the server has no
  // knowledge of the viewer's own clock or locale, so rendering a real
  // date/time during SSR would either be wrong or mismatch what the client
  // hydrates with. Same "nothing until mounted" pattern Sidebar's codename
  // uses for the same reason.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // Initial set deferred to a microtask — same pattern lib/useTheme.ts and
    // Sidebar's codename use — so this is a callback-triggered update, not a
    // synchronous setState in the effect body. The interval's own tick is
    // already inside a callback, so it doesn't need the same treatment.
    queueMicrotask(() => setNow(new Date()));
    const id = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(id);
  }, []);

  if (!now) {
    return <div aria-hidden="true" className="h-[26px] w-[118px]" />;
  }

  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="font-mono text-[11px] text-brand-blue">
        {now.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">
        {now.toLocaleTimeString()}
      </span>
    </div>
  );
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="3.6" />
      <path
        d="M10 2.3v2M10 15.7v2M17.7 10h-2M4.3 10h-2M15.44 4.56l-1.41 1.41M5.97 14.03l-1.41 1.41M15.44 15.44l-1.41-1.41M5.97 5.97 4.56 4.56"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path
        d="M17 11.2A7 7 0 0 1 8.8 3a7 7 0 1 0 8.2 8.2Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Monitor/device glyph for the "follow the browser/OS theme" option.
function DeviceIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="2.5" y="4" width="15" height="10" rx="1.6" />
      <path d="M7 17h6M10 14v3" strokeLinecap="round" />
    </svg>
  );
}

// Cycle order for the single toggle button below: light -> dark -> device
// -> back to light.
const THEME_CYCLE = [
  { value: "light" as const, label: "Light theme", Icon: SunIcon },
  { value: "dark" as const, label: "Dark theme", Icon: MoonIcon },
  { value: "system" as const, label: "Match device theme", Icon: DeviceIcon },
];

/*
 * One button, not a multi-option control: each click advances to the next
 * entry in THEME_CYCLE and calls setTheme() with it. The icon shown is
 * whichever entry matches the CURRENT selection (theme, not resolvedTheme)
 * — "device" gets its own distinct monitor icon rather than borrowing
 * sun/moon, so it reads as its own third state, not as light or dark
 * pretending to be something else. Selecting "device" hands off to
 * lib/useTheme.ts's "system" mode, which resolves against and then keeps
 * live-tracking window.matchMedia("(prefers-color-scheme: dark)") — so it
 * follows whatever the browser/OS is set to, including a change made there
 * while this tab stays open.
 */
function ThemeCycleButton() {
  const { theme, setTheme } = useTheme();

  const currentIndex = THEME_CYCLE.findIndex((entry) => entry.value === theme);
  const current = THEME_CYCLE[currentIndex] ?? THEME_CYCLE[0]!;

  const advance = () => {
    const next = THEME_CYCLE[(currentIndex + 1) % THEME_CYCLE.length]!;
    setTheme(next.value);
  };

  return (
    <button
      type="button"
      onClick={advance}
      aria-label={`Theme: ${current.label} — click to switch`}
      title={current.label}
      className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-border bg-panel text-muted-foreground transition-colors hover:text-foreground"
    >
      <current.Icon className="h-4 w-4" />
    </button>
  );
}

/* Hamburger — opens the off-canvas sidebar drawer below `md`. Hidden at
   `md` and up, where the sidebar is always in the layout (inline rail)
   instead of needing to be summoned. */
function MenuIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 5.5h14M3 10h14M3 14.5h14" strokeLinecap="round" />
    </svg>
  );
}

function MobileMenuButton() {
  const { mobileOpen, setMobileOpen } = useSidebarState();
  return (
    <button
      type="button"
      onClick={() => setMobileOpen((prev) => !prev)}
      aria-label={mobileOpen ? "Close menu" : "Open menu"}
      aria-expanded={mobileOpen}
      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-border bg-panel text-muted-foreground transition-colors hover:text-foreground md:hidden"
    >
      <MenuIcon className="h-4 w-4" />
    </button>
  );
}

export function TopBar() {
  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border bg-panel px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <MobileMenuButton />
        <Microtape />
      </div>

      <div className="flex items-center gap-3">
        {/* Hidden below `sm` — the wordmark + hamburger on the left and
            this clock + theme button on the right don't all fit a ~375px
            viewport at once; the clock is the least essential of the four. */}
        <div className="hidden sm:block">
          <Clock />
        </div>
        <ThemeCycleButton />
      </div>
    </header>
  );
}
