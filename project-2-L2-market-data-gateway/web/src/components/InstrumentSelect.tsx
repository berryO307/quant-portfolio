"use client";

import { INSTRUMENTS, type InstrumentConfig } from "@/lib/instruments";

// Selecting an entry navigates to /orderbook?symbol=<symbol> (see
// Dashboard's handleInstrumentChange); the page then connects to that
// instrument's channel on the one relay. It never starts or reconfigures a
// gateway: an instrument with no feed shows the "feed unavailable" state.
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
      title="Instrument"
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
