"use client";

import { useEffect, useState } from "react";

/*
 * "$ MICROTAPE █" cipher-resolve wordmark — reveals one correct letter at a
 * time from the left; everything still to come renders as a randomly
 * cycling scramble glyph. Holds fully resolved for a beat, then resets and
 * repeats. A real timed state loop (setTimeout/setInterval-driven state),
 * not a CSS animation — the unresolved glyphs are genuinely different
 * characters each tick, not a fade/opacity trick.
 *
 * Colors come from dedicated CSS variables (globals.css: --microtape-word,
 * --microtape-dollar — same hex in both themes, per spec) and the existing
 * theme mechanism — the `dark` class on <html> that lib/useTheme.ts already
 * owns — not a new one. Only the glow intensity differs between themes; the
 * animation timing below is identical in both.
 */

const TARGET = "MICROTAPE";

// Dense/techy noise — digits, symbols, a few katakana — not alphabetic.
const SCRAMBLE_CHARS =
  "0123456789#$%&*+=-<>/\\|~^アイウエオカキクケコサシスセソタチ";

const REVEAL_INTERVAL_MS = 100; // per-letter reveal cadence
const SCRAMBLE_INTERVAL_MS = 55; // unrevealed glyphs re-roll this often
const HOLD_MS = 1800; // pause once fully resolved, before re-scrambling
const CURSOR_BLINK_MS = 380; // independent of the reveal/scramble ticks

function randomGlyph(): string {
  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]!;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Deferred to a microtask — same pattern lib/useTheme.ts uses — so this
    // is a callback-triggered update, not a synchronous setState call
    // directly in the effect body.
    queueMicrotask(() => setReduced(media.matches));
    const sync = () => setReduced(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function Microtape() {
  const reducedMotion = usePrefersReducedMotion();
  const [revealCount, setRevealCount] = useState(0);
  const [scrambleTick, setScrambleTick] = useState(0);
  const [cursorOn, setCursorOn] = useState(true);

  // False on the server and on the client's first render — only flipped
  // true from an effect, i.e. once this is confirmed running on the
  // client. Math.random() (randomGlyph, below) can only be called once
  // this is true: calling it during the pre-mount render produced
  // different scrambled characters on the server vs. the client's first
  // render, a hydration mismatch React had to discard and redo. Before
  // mount, unresolved letters render the real target letter instead —
  // deterministic, so server and client output are byte-identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  // Reveal loop: one more correct letter every REVEAL_INTERVAL_MS, then a
  // HOLD_MS pause at fully-resolved, then back to zero and repeat.
  // Recursive setTimeout rather than setInterval so the hold — a different
  // duration — is just another leg of the same chain instead of a second
  // timer that has to be kept in sync with this one. Gated on `mounted` in
  // addition to `reducedMotion` so nothing runs before the client has
  // confirmed the pre-mount (deterministic) frame already committed.
  useEffect(() => {
    if (!mounted || reducedMotion) return;
    let cancelled = false;
    let count = 0;
    let timeoutId: ReturnType<typeof setTimeout>;

    const step = () => {
      if (cancelled) return;
      if (count < TARGET.length) {
        count += 1;
        setRevealCount(count);
        timeoutId = setTimeout(step, REVEAL_INTERVAL_MS);
      } else {
        timeoutId = setTimeout(() => {
          if (cancelled) return;
          count = 0;
          setRevealCount(0);
          timeoutId = setTimeout(step, REVEAL_INTERVAL_MS);
        }, HOLD_MS);
      }
    };

    timeoutId = setTimeout(step, REVEAL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [mounted, reducedMotion]);

  // Scramble refresh: re-rolls the not-yet-revealed glyphs on its own
  // faster tick, independent of the reveal cadence above.
  useEffect(() => {
    if (!mounted || reducedMotion) return;
    const id = setInterval(() => setScrambleTick((t) => t + 1), SCRAMBLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [mounted, reducedMotion]);

  // Cursor blink: its own independent, faster interval — unsynced from
  // both ticks above.
  useEffect(() => {
    if (!mounted || reducedMotion) return;
    const id = setInterval(() => setCursorOn((on) => !on), CURSOR_BLINK_MS);
    return () => clearInterval(id);
  }, [mounted, reducedMotion]);

  if (reducedMotion) {
    return (
      <span className="inline-flex items-baseline gap-[0.4em] font-mono text-[19px] font-semibold tracking-[0.16em]">
        <span className="tf-microtape-dollar">$</span>
        <span className="tf-microtape-resolved">{TARGET}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-[0.4em] font-mono text-[19px] font-semibold tracking-[0.16em]">
      <span className="tf-microtape-dollar">$</span>
      <span className="inline-flex items-baseline">
        {TARGET.split("").map((letter, i) =>
          i < revealCount ? (
            <span key={i} className="tf-microtape-resolved inline-block w-[1ch] text-center">
              {letter}
            </span>
          ) : (
            // Keyed by scrambleTick too, alongside index — forces a fresh
            // glyph pick each scramble tick rather than reusing whatever
            // random() happened to run for this index during the previous
            // render for some other reason (e.g. a parent re-render). Only
            // keyed that way once mounted — before that the key must stay
            // stable across the server/client-first-render pair.
            <span
              key={mounted ? `${i}-${scrambleTick}` : i}
              className="tf-microtape-scramble inline-block w-[1ch] overflow-hidden text-center"
            >
              {mounted ? randomGlyph() : letter}
            </span>
          ),
        )}
      </span>
      {/* A sized box, not the "█" glyph — that character's own font metrics
          render much taller than the cap-height of the surrounding text in
          most monospace fonts, which is why the cursor looked oversized.
          This stays proportional to the text at any size since it's in em
          units off the same font-size. */}
      <span
        aria-hidden="true"
        className="tf-microtape-cursor inline-block h-[0.9em] w-[0.5em]"
        style={{ opacity: cursorOn ? 1 : 0 }}
      />
    </span>
  );
}
