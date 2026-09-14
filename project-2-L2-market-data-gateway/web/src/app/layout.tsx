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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">{children}</body>
    </html>
  );
}
