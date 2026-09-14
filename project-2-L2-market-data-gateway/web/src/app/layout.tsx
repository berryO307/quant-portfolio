import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Names picked to match globals.css's --font-sans/--font-mono, which
// reference var(--font-inter)/var(--font-jetbrains-mono) directly — the
// tweakcn theme's font stack, wired to real loaded fonts instead of falling
// back to system-ui/monospace.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "L2 Gateway Viewer",
  description: "Live order book ladder and trades tape, fed by the relay's WebSocket feed.",
};

// Runs before React hydrates (a plain inline <script>, not next/script —
// anything deferred would paint the wrong theme first, then flash to the
// right one). Reads the same localStorage key lib/useTheme.ts's toggle
// writes to and applies the `dark` class synchronously, so the very first
// paint already matches whatever the user picked last time. Defaults to
// dark — this dashboard's original, only appearance before the toggle
// existed — rather than following the OS/browser's prefers-color-scheme,
// since dark was a deliberate design choice here, not a system fallback.
const THEME_SET_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"){document.documentElement.classList.add("dark");}}catch(e){document.documentElement.classList.add("dark");}})();`;

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
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">{children}</body>
    </html>
  );
}
