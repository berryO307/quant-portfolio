"use client";

import { INSTRUMENTS, type InstrumentConfig } from "@/lib/instruments";

// Selecting an entry here just switches which relay endpoint the browser
// connects to (see lib/instruments.ts's header comment) — it does NOT
// start or reconfigure any gateway process. An instrument whose own
// gateway/relay pair isn't currently running shows the existing "feed
// unavailable" state (FeedStatusBanner) once selected, same as today's
// single-instrument dashboard does when the relay is down.
export function InstrumentSelect({
  value,
  onChange,
}: {
  value: InstrumentConfig;
  onChange: (instrument: InstrumentConfig) => void;
}) {
  return (
    <select
      value={value.id}
      onChange={(e) => {
        const next = INSTRUMENTS.find((i) => i.id === e.target.value);
        if (next) onChange(next);
      }}
      title="Instrument — selecting one connects to its own relay endpoint, started independently"
      className="rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-foreground"
    >
      {INSTRUMENTS.map((i) => (
        <option key={i.id} value={i.id}>
          {i.label}
        </option>
      ))}
    </select>
  );
}
