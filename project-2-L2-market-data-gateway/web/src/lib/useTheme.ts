"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

// Same key app/layout.tsx's no-FOUC inline script reads before hydration —
// this hook is the only thing that ever writes it.
const STORAGE_KEY = "theme";

function readCurrentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// Single source of truth for the light/dark toggle: reads whatever class
// the no-FOUC script already applied (so the hook's initial value matches
// the DOM instead of assuming), and both the DOM class and localStorage
// only ever change through toggle() here.
export function useTheme(): { theme: Theme; toggle: () => void } {
  // Lazy initializer reads the DOM directly rather than defaulting to a
  // hardcoded value — on the client this already reflects what the no-FOUC
  // script decided, avoiding a mismatched flash between this hook's first
  // render and the class actually on <html>.
  const [theme, setTheme] = useState<Theme>(readCurrentTheme);

  useEffect(() => {
    // Reconcile once after mount in case SSR's initial render (which has
    // no DOM to read and no way to know the stored preference) guessed
    // differently from what the inline script actually applied. Deferred
    // to a microtask so this is a callback-triggered update, not a
    // synchronous setState call directly in the effect body.
    queueMicrotask(() => setTheme(readCurrentTheme()));
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Some private-browsing modes throw on localStorage access — the
        // toggle still works for this page load, it just won't persist.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
