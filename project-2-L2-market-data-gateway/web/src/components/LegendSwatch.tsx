// Shared by DepthCurve and LatencyChart (Phase 8.5's second pass): replaces
// uPlot's built-in legend, which renders as a permanent multi-row block of
// "label: --" placeholders that only ever show a value while the cursor is
// over a point — on a chart this compact, that block was taller than the
// chart itself. A live value on hover belongs in a cursor tooltip instead
// (see each chart's own tooltip); this is just the static color key.
export function LegendSwatch({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      {dashed ? (
        <span
          className="inline-block h-0 w-3 border-t-2"
          style={{ borderColor: color, borderStyle: "dashed" }}
          aria-hidden
        />
      ) : (
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      )}
      {label}
    </span>
  );
}
