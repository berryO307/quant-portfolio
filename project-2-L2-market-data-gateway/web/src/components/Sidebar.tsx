"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  faceFor,
  loadOrCreateCodename,
  paletteFor,
  shuffleCodename,
} from "@/lib/anonIdentity";
import { useSidebarState } from "@/lib/sidebarState";

/*
 * Collapsible left rail. Presentational; the only state it owns directly is
 * the anonymous session codename (see lib/anonIdentity) — the collapsed
 * flag itself now lives in lib/sidebarState so other parts of the app shell
 * (currently just the architecture page's bottom-left zoom readout) can
 * read it too. Sidebar is still the only writer.
 *
 * There is no auth in this project, so the identity block deliberately shows
 * a generated codename and "anonymous session" — never an email, account or
 * sign-out action.
 */

const NAV_ITEMS = [
  { href: "/orderbook", label: "Order Book", icon: BookIcon },
  { href: "/architecture", label: "System Architecture", icon: DiagramIcon },
] as const;

function BookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M3 8h14M7.5 11.5h6M7.5 14h4" strokeLinecap="round" />
    </svg>
  );
}

function DiagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="7.5" width="5" height="5" rx="1.2" />
      <rect x="12.5" y="3" width="5" height="5" rx="1.2" />
      <rect x="12.5" y="12" width="5" height="5" rx="1.2" />
      <path d="M7.5 10h2.5M10 10V5.5h2.5M10 10v4.5h2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShuffleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 5.5h3.5l7 9H17M3 14.5h3.5l2.2-2.8M12.2 7.3l1.3-1.8H17" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 3.5L17 5.5 15 7.5M15 12.5l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CoffeeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 8h10v4.5A3.5 3.5 0 0 1 10.5 16h-3A3.5 3.5 0 0 1 4 12.5V8Z" />
      <path d="M14 9h1.5a2 2 0 1 1 0 4H14" />
      <path d="M6.5 3.5v2M9.5 3.5v2M12.5 3.5v2" strokeLinecap="round" />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M3.4 5.3H.9V15h2.5V5.3ZM2.15 1a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9ZM15 9.4c0-2.6-1.4-3.8-3.2-3.8-1.5 0-2.2.8-2.6 1.4V5.3H6.7V15h2.5V9.6c0-1.1.2-2.2 1.6-2.2 1.3 0 1.4 1.3 1.4 2.3V15H15V9.4Z" />
    </svg>
  );
}

function AnonAvatar({ name, size = 30 }: { name: string; size?: number }) {
  const palette = paletteFor(name);
  const face = faceFor(name);

  return (
    <span
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{
        width: size,
        height: size,
        backgroundImage: `linear-gradient(135deg, ${palette.from}, ${palette.to})`,
      }}
      aria-hidden="true"
    >
      {/* Keyed by name (not just codename→file) so shuffling to a NEW
          codename remounts this element and the pop-in + idle-wiggle
          animation (tf-emoji-avatar, globals.css) replays from the start,
          even on the rare shuffle that lands on the same face. */}
      <Image
        key={name}
        src={`/avatars/${face.file}`}
        alt={face.label}
        width={Math.round(size * 0.8)}
        height={Math.round(size * 0.8)}
        unoptimized
        className="tf-emoji-avatar pointer-events-none select-none"
      />
    </span>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { expanded, setExpanded, mobileOpen, setMobileOpen } = useSidebarState();

  // Empty on the server and on the first client render, filled after mount —
  // sessionStorage isn't readable during SSR, and rendering a name the
  // server couldn't know would be a hydration mismatch.
  const [codename, setCodename] = useState("");
  useEffect(() => {
    // Deferred to a microtask so this is a callback-triggered update rather
    // than a synchronous setState in the effect body — same pattern
    // lib/useTheme.ts and lib/chartTheme.ts already use for reading a value
    // that only exists on the client.
    queueMicrotask(() => setCodename(loadOrCreateCodename()));
  }, []);

  // Close the mobile drawer on route change — otherwise navigating to
  // "System Architecture" from the drawer would leave it open, covering
  // the very page the user just picked. Deferred to a microtask, same
  // pattern as the codename effect above, so this is a callback-triggered
  // update rather than a synchronous setState in the effect body.
  useEffect(() => {
    queueMicrotask(() => setMobileOpen(false));
  }, [pathname, setMobileOpen]);

  return (
    <>
      {/* Backdrop — mobile drawer only (md:hidden), sits between the
          sidebar (z-40) and everything else, click-to-close. Doesn't
          exist at all when the drawer is closed, so it can never
          intercept clicks on the rest of the page by accident. */}
      {mobileOpen && (
        <div
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[264px] shrink-0 flex-col border-r border-border bg-panel transition-transform duration-200 md:static md:z-auto md:w-auto md:translate-x-0 md:transition-[width] ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        } ${expanded ? "md:w-[264px]" : "md:w-[56px]"}`}
      >
        {/* Collapse toggle — desktop only (md:flex); mobile closes via the
            backdrop or the hamburger button instead, there's no separate
            "collapsed" state on the drawer. */}
        <div className={`hidden items-center px-3 py-2.5 md:flex ${expanded ? "justify-end" : "justify-center"}`}>
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
            title={expanded ? "Collapse sidebar" : "Expand sidebar"}
            className="rounded-[7px] p-1.5 text-dim transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronIcon className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>

        <div className="hidden border-t border-border md:block" />

        {/* Nav — always shows labels on mobile (the drawer only ever opens
            at full width there); md: follows the desktop expanded/collapsed
            state as before. */}
        <nav className="flex flex-col gap-1 px-2 pt-2 md:pt-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                title={label}
                className={`flex items-center gap-3 rounded-[9px] px-3 py-2.5 text-[13px] transition-colors ${
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                } ${expanded ? "" : "md:justify-center"}`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                <span className={`truncate ${expanded ? "" : "md:hidden"}`}>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        {/* Bottom block. On the desktop collapsed rail (md, !expanded,
            drawer not open), it's an icon-only column (avatar, coffee,
            GitHub, LinkedIn) instead of disappearing entirely — text
            (codename, "Built by Barinder Singh", labels) has nowhere sane
            to go at 56px wide, so only the glyphs survive. The mobile
            drawer always opens at full width regardless of the desktop
            rail's remembered expanded/collapsed state, so it always gets
            the full block, not the icon-only one. */}
        {!expanded && !mobileOpen && (
          <div className="flex flex-col items-center gap-2.5 border-t border-border p-2 py-3">
          {codename ? (
            <AnonAvatar name={codename} size={30} />
          ) : (
            <span className="h-[30px] w-[30px] shrink-0 rounded-full bg-muted" />
          )}
          <a
            href="https://buymeacoffee.com/berry07"
            target="_blank"
            rel="noreferrer"
            aria-label="Buy me a coffee"
            title="Buy me a coffee"
            className="rounded-[7px] border border-border p-1.5 text-brand-amber transition-colors hover:border-brand-amber/50"
          >
            <CoffeeIcon className="h-4 w-4" />
          </a>
          <a
            href="https://github.com/berryO307"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            title="GitHub"
            className="rounded-[7px] border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <GitHubIcon className="h-4 w-4" />
          </a>
          <a
            href="https://www.linkedin.com/in/berry07/"
            target="_blank"
            rel="noreferrer"
            aria-label="LinkedIn"
            title="LinkedIn"
            className="rounded-[7px] border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <LinkedInIcon className="h-4 w-4" />
          </a>
        </div>
      )}
        {(expanded || mobileOpen) && (
          <div className="flex flex-col gap-3.5 border-t border-border p-3.5">
          {/* 1. Buy me a coffee */}
          <a
            href="https://buymeacoffee.com/berry07"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 rounded-[10px] border border-border bg-muted p-2.5 transition-colors hover:border-brand-amber/50"
          >
            <Image
              src="/bmc-qr.png"
              alt="Buy Me a Coffee QR code"
              width={44}
              height={44}
              className="h-11 w-11 shrink-0 rounded-[6px]"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] leading-tight text-dim">Enjoying this?</span>
              <span className="mt-1 flex items-center gap-1.5 text-[13px] leading-tight font-medium text-brand-amber">
                <CoffeeIcon className="h-4 w-4 shrink-0" />
                <span className="truncate">Buy me a coffee →</span>
              </span>
            </span>
          </a>

          {/* 2. Identity */}
          <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-muted p-2.5">
            {codename ? <AnonAvatar name={codename} size={38} /> : <span className="h-[38px] w-[38px] shrink-0 rounded-full bg-muted" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-tight font-medium text-foreground">
                {codename || "…"}
              </span>
              <span className="block text-[11px] leading-tight text-dim">anonymous session</span>
            </span>
            <button
              type="button"
              onClick={() => setCodename(shuffleCodename())}
              aria-label="Shuffle codename"
              title="Shuffle codename"
              className="rounded-[7px] border border-border p-1.5 text-dim transition-colors hover:text-foreground"
            >
              <ShuffleIcon className="h-4 w-4" />
            </button>
          </div>

          {/* 3. Built by — a single-color sheen sweep (tf-shimmer,
              globals.css): base color is the theme's own foreground, with
              one brand-blue highlight passing through, so it reads
              correctly in both light and dark instead of tf-wordmark's
              multi-hue gradient loop (too loud for a credit line). Kept
              the larger/bolder sizing so it's still the stand-out line of
              this block. */}
          <div className="flex flex-col gap-1">
            {/* Built by / Barinder Singh are two lines of ONE tf-shimmer
                element (not two separate ones) so the sweep is provably a
                single animation instance across both, not just two
                identically-timed ones that happen to line up. */}
            <span className="flex items-center justify-between gap-2">
              <span className="tf-shimmer flex flex-col leading-tight">
                <span className="text-[12px] font-medium">Built by</span>
                <span className="text-[17px] font-bold">Barinder Singh</span>
              </span>
              <span className="flex shrink-0 items-end gap-1.5 self-end">
                <a
                  href="https://github.com/berryO307"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub"
                  title="GitHub"
                  className="rounded-[7px] border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <GitHubIcon className="h-3.5 w-3.5" />
                </a>
                <a
                  href="https://www.linkedin.com/in/berry07/"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="LinkedIn"
                  title="LinkedIn"
                  className="rounded-[7px] border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <LinkedInIcon className="h-3.5 w-3.5" />
                </a>
              </span>
            </span>
          </div>
        </div>
        )}
      </aside>
    </>
  );
}
