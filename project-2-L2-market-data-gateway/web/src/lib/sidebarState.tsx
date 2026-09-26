"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

/*
 * Sidebar state shared across the app shell:
 *  - `expanded` — the desktop rail's collapsed/expanded width. Lifted out
 *    of Sidebar.tsx's own local state so other parts of the shell can react
 *    to it — currently just the architecture page's bottom-left zoom
 *    readout, which fades while the sidebar is expanded.
 *  - `mobileOpen` — whether the off-canvas drawer is open below the `md`
 *    breakpoint. A separate flag rather than reusing `expanded`: on mobile
 *    there's no "collapsed rail" state, only "hidden off-canvas" or "open
 *    as a full overlay drawer" — two different concepts that happened to
 *    share a boolean would fight each other (e.g. collapsing the desktop
 *    rail must never also close the mobile drawer, and vice versa). Read
 *    by TopBar (owns the hamburger button that opens it) and written by
 *    both TopBar and Sidebar (which closes it on nav / backdrop click).
 */

interface SidebarState {
  expanded: boolean;
  setExpanded: (next: boolean | ((prev: boolean) => boolean)) => void;
  mobileOpen: boolean;
  setMobileOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
}

const SidebarStateContext = createContext<SidebarState | null>(null);

export function SidebarStateProvider({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <SidebarStateContext.Provider value={{ expanded, setExpanded, mobileOpen, setMobileOpen }}>
      {children}
    </SidebarStateContext.Provider>
  );
}

export function useSidebarState(): SidebarState {
  const ctx = useContext(SidebarStateContext);
  if (!ctx) {
    throw new Error("useSidebarState must be used within SidebarStateProvider");
  }
  return ctx;
}

/** Read-only convenience for consumers that only care about the flag. */
export function useSidebarExpanded(): boolean {
  const ctx = useContext(SidebarStateContext);
  return ctx?.expanded ?? true;
}
