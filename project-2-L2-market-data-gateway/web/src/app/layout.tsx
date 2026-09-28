import type { Metadata } from "next";
import { DM_Sans, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { TopBar } from "@/components/TopBar";
import { Sidebar } from "@/components/Sidebar";
import { SidebarStateProvider } from "@/lib/sidebarState";
import { FeedModeStateProvider } from "@/lib/feedModeState";

// Names picked to match globals.css's --font-sans/--font-mono, which
// reference var(--font-dm-sans)/var(--font-geist-mono) directly — this
// theme's own font stack, wired to real loaded fonts instead of falling
// back to system-ui/monospace. Replaces the previous theme's IBM Plex
// Sans/Mono (UI) and Inter/JetBrains Mono (fallback tier) entirely, rather
// than keeping four font families loaded when only one sans + one mono are
// actually specified by the current theme. "variable" loads the single
// variable-weight file instead of enumerating static weights.
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: "variable",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: "variable",
});

export const metadata: Metadata = {
  title: "L2 Gateway Viewer",
  description: "Live order book ladder and trades tape, fed by the relay's WebSocket feed.",
};

// Runs before React hydrates (a plain inline <script>, not next/script —
// anything deferred would paint the wrong theme first, then flash to the
// right one). Reads the same localStorage key lib/useTheme.ts's setTheme()
// writes to and applies the `dark` class synchronously, so the very first
// paint already matches whatever the user picked last time — including
// "system", which is resolved against matchMedia right here rather than
// left to flash the fallback appearance until React mounts. Nothing stored
// yet still defaults to dark, not the OS preference — this dashboard's
// original, only appearance before the toggle existed, kept as the
// fallback for a genuinely first-time visitor; only an explicit "system"
// selection follows the OS.
const THEME_SET_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");var dark;if(t==="light"){dark=false;}else if(t==="system"){dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;}else{dark=true;}if(dark){document.documentElement.classList.add("dark");}}catch(e){document.documentElement.classList.add("dark");}})();`;

// React 19 warns ("Encountered a script tag while rendering React
// component") on ANY raw <script> element in the render tree — a known
// false positive for exactly this anti-flash-of-wrong-theme pattern (same
// open issue against next-themes, shadcn/ui's dark-mode guide, and HeroUI
// as of Sept 2026; no clean upstream fix exists). The script still runs
// correctly and the theme still works — this is dev-console noise, not a
// real bug. Removing the inline script instead would reintroduce the
// actual flash it exists to prevent, so the warning is suppressed instead.
//
// Has to be part of THIS SAME synchronous script, not a separate module
// loaded via a client component's useEffect: the warning fires DURING
// React's hydration pass, when it first encounters the <script> tag in the
// tree — a useEffect only runs AFTER a component mounts, which is after
// hydration has already happened, too late to catch it. Prepending the
// patch here means it's already active by the time hydration's warning
// would otherwise fire, since it's one synchronous script executed before
// React's hydration bundle even runs.
//
// Gated by NODE_ENV at render time (baked into the string server-side,
// not a runtime check) so this never ships to production, where dev-only
// console warnings don't apply and there's nothing to suppress.
const SUPPRESS_SCRIPT_TAG_WARNING =
  process.env.NODE_ENV === "development"
    ? `(function(){try{var e=console.error;console.error=function(){if(typeof arguments[0]==="string"&&arguments[0].indexOf("Encountered a script tag")!==-1){return;}e.apply(console,arguments);};}catch(err){}})();`
    : "";

const THEME_INIT_SCRIPT = SUPPRESS_SCRIPT_TAG_WARNING + THEME_SET_SCRIPT;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${geistMono.variable} h-full antialiased`}
      // The theme-init script (below) adds the "dark" class to this element
      // BEFORE React hydrates, by design — that's what prevents a flash of
      // the wrong theme on load (see THEME_SET_SCRIPT's own comment). That
      // makes the server-rendered className and the actual DOM's className
      // intentionally differ by the time hydration runs, which React
      // otherwise reports as a hydration mismatch on this exact element.
      // suppressHydrationWarning tells React that divergence on <html>
      // specifically is expected and not a bug — it does not suppress
      // mismatches anywhere else in the tree, only on this one element's
      // own attributes.
      suppressHydrationWarning
    >
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
      </head>
      {/* App shell: top bar across the full width, collapsible rail on the
          left (an off-canvas drawer below `md`, opened via TopBar's
          hamburger button — see Sidebar.tsx), routed content filling the
          rest. SidebarStateProvider wraps TopBar too now, not just the row
          below, since the hamburger button that opens the mobile drawer
          lives in TopBar and needs to write the same shared state
          Sidebar reads. */}
      <body className="h-full flex flex-col overflow-hidden bg-background text-foreground">
        <SidebarStateProvider>
          <FeedModeStateProvider>
            <TopBar />
            <div className="flex min-h-0 flex-1">
              <Sidebar />
              <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
            </div>
          </FeedModeStateProvider>
        </SidebarStateProvider>
      </body>
    </html>
  );
}
