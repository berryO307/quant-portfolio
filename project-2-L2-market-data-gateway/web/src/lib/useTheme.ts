"use client";

import { useCallback, useEffect, useState } from "react";

// The user's SELECTED preference — "system" means "follow the browser/OS
// prefers-color-scheme", not a fixed appearance of its own.
export type Theme = "light" | "dark" | "system";
// The appearance actually applied to <html>.dark — always one of these two,
// even when the selection is "system".
export type ResolvedTheme = "light" | "dark";

// Same key app/layout.tsx's no-FOUC inline script reads before hydration —
// this hook is the only thing that ever writes it. Can now hold "system" as
// well as "light"/"dark"; that script was updated to match (see its own
// comment there).
const STORAGE_KEY = "theme";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Some private-browsing modes throw on localStorage access.
  }
  // Original default for a first-time visitor: dark, not the OS preference
  // — a deliberate design choice from before this toggle existed, kept as
  // the fallback when nothing has been explicitly chosen yet. Only an
  // explicit "system" selection below actually follows the OS.
  return "dark";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(theme: Theme): ResolvedTheme {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

function readAppliedTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// Single source of truth for the theme control: reads whatever the no-FOUC
// script already applied (so the hook's initial values match the DOM
// instead of assuming), and the DOM class + localStorage only ever change
// through setTheme()/toggle() here.
export function useTheme(): {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
} {
  // Fixed initial values — deliberately NOT lazy initializers reading the
  // DOM/localStorage: those read differently on the server than on the
  // client's first hydration render, which is exactly the server/client
  // mismatch pattern React's own hydration warning calls out (reported live
  // on this component's own buttons previously). Matching SSR's "dark" on
  // both first renders avoids that; the effect below corrects to the real
  // values immediately after hydration commits.
  const [theme, setThemeState] = useState<Theme>("dark");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");

  useEffect(() => {
    // Deferred to a microtask so this is a callback-triggered update, not a
    // synchronous setState call directly in the effect body.
    queueMicrotask(() => {
      setThemeState(readStoredTheme());
      setResolvedTheme(readAppliedTheme());
    });
  }, []);

  // Applies whenever the selection changes, and — only while "system" is
  // selected — keeps listening for the OS preference changing live (e.g.
  // the user flips their OS/Chrome theme without touching this app at all).
  useEffect(() => {
    if (theme !== "system") {
      document.documentElement.classList.toggle("dark", theme === "dark");
      // Deferred to a microtask — same reasoning as the mount effect above:
      // this keeps every setResolvedTheme call in this hook going through a
      // callback rather than running synchronously in an effect body.
      queueMicrotask(() => setResolvedTheme(theme));
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const sync = () => {
      const next: ResolvedTheme = media.matches ? "dark" : "light";
      document.documentElement.classList.toggle("dark", next === "dark");
      setResolvedTheme(next);
    };

    // First application deferred (mount-time effect run, same reasoning as
    // above); the "change" listener itself already only ever fires from a
    // real browser event, never synchronously from this effect body.
    queueMicrotask(sync);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Some private-browsing modes throw on localStorage access — the
      // selection still works for this page load, it just won't persist.
    }
  }, []);

  // Kept for existing callers (e.g. the pre-existing, currently-unused
  // ThemeToggle.tsx): a plain light<->dark flip based on what's actually
  // showing right now. Toggling away from "system" is exactly what should
  // happen here — a two-way flip has no third state to land on.
  const toggle = useCallback(() => {
    setTheme(resolve(theme) === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return { theme, resolvedTheme, setTheme, toggle };
}
