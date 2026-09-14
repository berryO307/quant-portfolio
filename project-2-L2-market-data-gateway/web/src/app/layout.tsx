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
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"){document.documentElement.classList.add("dark");}}catch(e){document.documentElement.classList.add("dark");}})();`;

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
