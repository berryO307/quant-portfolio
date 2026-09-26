"use client";

import { memo, type ComponentType } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  COLOR,
  COL_X,
  CANVAS_WIDTH,
  END_CAP_WIDTH,
  ROW_GAP,
  STAGE_WIDTH,
} from "./layout";

/*
 * React Flow custom nodes for the architecture diagram.
 *
 * Hierarchy pass: no numbered section headings anywhere on this canvas —
 * the page title (ArchitectureView.tsx, outside the canvas) is the only
 * heading. Everything below is one continuous set of React Flow nodes on
 * one coordinate system: the five-stage pipeline starting near the left
 * edge, its one remaining supporting card (Capture Sink) under Gateway,
 * and the latency instrumentation timeline as one full-width card
 * underneath all of it. Pan/zoom moves and scales all of it together
 * because none of it is a separate DOM layer — it's all real nodes with
 * real {x, y} positions on the same React Flow canvas (see
 * ARCHITECTURE_NODES at the bottom, and layout.ts for the shared
 * geometry). Legend is the one exception — it's `LegendCard`, a plain
 * exported component ArchitectureView.tsx renders as a screen-fixed
 * overlay OUTSIDE this canvas, specifically so it does NOT pan/zoom with
 * everything else.
 */

const HANDLE_STYLE: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  border: "none",
  background: "none",
};

function H({
  type,
  position,
  id,
}: {
  type: "source" | "target";
  position: Position;
  id: string;
}) {
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      isConnectable={false}
      style={HANDLE_STYLE}
    />
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Primitives
   ──────────────────────────────────────────────────────────────────────── */

type Item = readonly [label: string, tag: string];

/** Justified fact row: label left, small monospace pill right. Used by the
 * sidebar and supporting cards — NOT the five primary pipeline cards (see
 * Bullet below for those; the pill-per-fact density is exactly what makes
 * a reference card like System Constants scannable, but read as clutter on
 * the primary flow cards). */
function Row({
  label,
  tag,
  tagColor,
}: {
  label: string;
  tag: string;
  tagColor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-1.5 rounded-[7px] border border-border/70 bg-muted px-1.5 py-0.5">
      <span className="min-w-0 flex-1 text-[12px] leading-snug text-muted-foreground">
        {label}
      </span>
      <span
        className="shrink-0 rounded-[5px] bg-background/60 px-1.5 py-0.5 font-mono text-[10.5px]"
        style={{ color: tagColor ?? "var(--dim)" }}
      >
        {tag}
      </span>
    </div>
  );
}

function GroupLabel({
  children,
  color,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <div
      className="mb-0.5 text-[11px] font-semibold tracking-[0.12em] uppercase"
      style={{ color: color ?? "var(--dim)" }}
    >
      {children}
    </div>
  );
}

/** A labelled group of `label | tag` rows. Two per row once there's more
 * than one item, UNLESS `cols={1}` is forced — a 2-up row only has room
 * for a label+tag pair when the card itself is wide (the pipeline row's
 * 460-560px cards). In the sidebar's narrow 300px column, 2-up halves each
 * cell to ~130px, which isn't enough width for an unbreakable identifier
 * (no space/hyphen for the browser to wrap at, e.g. "consumer_thread") to
 * coexist with its tag — the text overflows straight through the tag
 * instead of wrapping, a real bug this component used to have. Callers in
 * a narrow column pass `cols={1}`. */
function Group({
  label,
  items,
  labelColor,
  tagColor,
  cols,
}: {
  label?: string;
  items: readonly Item[];
  labelColor?: string;
  tagColor?: string;
  cols?: 1 | 2;
}) {
  const resolvedCols = cols ?? (items.length > 1 ? 2 : 1);
  return (
    <div>
      {label && <GroupLabel color={labelColor}>{label}</GroupLabel>}
      <div
        className={`grid gap-1 ${resolvedCols === 2 ? "grid-cols-2" : "grid-cols-1"}`}
      >
        {items.map(([itemLabel, tag]) => (
          <Row
            key={`${itemLabel}|${tag}`}
            label={itemLabel}
            tag={tag}
            tagColor={tagColor}
          />
        ))}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[7px] border border-border/60 bg-muted px-2 py-1 text-[12px] leading-snug text-dim">
      {children}
    </p>
  );
}

/** Small pill badge, top-right of a card (HOT PATH / WRITE-ONLY). */
function CornerBadge({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="absolute top-3 right-3 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
      }}
    >
      {text}
    </span>
  );
}

interface StripRow {
  key: string;
  value: string;
}

/** The in/out contract strip, pinned to a pipeline card's bottom edge.
 * Card reserves bottom padding via its own `stripRows` prop so content can
 * never slide under this. */
function InOutStrip({ rows }: { rows: readonly StripRow[] }) {
  return (
    <div
      className="absolute inset-x-0 bottom-0 rounded-b-[12px] border-t border-border/70 px-3 py-1"
      style={{ backgroundColor: "var(--strip-bg)" }}
    >
      {rows.map((r) => (
        <div key={r.key} className="font-mono text-[10px] leading-snug">
          <span className="text-dim">{r.key} → </span>
          <span className="text-muted-foreground">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Stage icon badge — static glow + a radar ping staggered per stage
 * index, so the row ripples left to right. Generic glyphs only — no brand
 * logos. */
function StageIcon({
  glyph,
  color,
  delayIndex,
}: {
  glyph: React.ReactNode;
  color: string;
  delayIndex: number;
}) {
  return (
    <span
      className="tf-stage-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold"
      style={
        {
          color,
          borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
          backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
          filter: `drop-shadow(0 0 5px color-mix(in srgb, ${color} 55%, transparent))`,
          ["--tf-icon-delay" as string]: `${delayIndex * 0.35}s`,
        } as React.CSSProperties
      }
    >
      {glyph}
    </span>
  );
}

function GlyphCircleLines() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="3.2" />
      <path
        d="M10 1.5v3.4M10 15.1v3.4M1.5 10h3.4M15.1 10h3.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
function GlyphHexagon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M10 2 17 6v8l-7 4-7-4V6z" strokeLinejoin="round" />
    </svg>
  );
}
function GlyphPerson() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="10" cy="6.3" r="3" />
      <path
        d="M3.3 17c1-3.6 4-5.6 6.7-5.6s5.7 2 6.7 5.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Card — flow-zone (`bg-panel`) by default, or `flat` (the sidebar's
 * visibly demoted `card-flat` token: flatter background, muted border, no
 * icon, no animation, muted accents). */
function Card({
  title,
  subtitle,
  accent,
  icon,
  badge,
  flat = false,
  stripRows,
  className = "",
  borderColor,
  children,
}: {
  title: string;
  subtitle?: string;
  accent?: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  flat?: boolean;
  stripRows?: readonly StripRow[];
  className?: string;
  /** Overrides the card's own border colour — used to visually "wrap" a
   * card in a status colour (e.g. hot-path red) instead of a separate
   * corner badge, so the association reads directly off the card itself
   * rather than a small disconnected pill. */
  borderColor?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      // pb-14, not pb-10: narrower cards (see STAGE_WIDTH/END_CAP_WIDTH's
      // own comment) mean the strip's longer lines — gateway's "out" row
      // especially — now wrap to an extra line more often, so the
      // reserved space needs to cover a 3-line strip (in: 1 line, out: up
      // to 2), not the 2-line case pb-10 was sized for. Same bug as
      // before if this falls short: the card's own last content row
      // hides behind the strip.
      className={`relative rounded-[12px] border p-2 ${stripRows ? "pb-14" : ""} ${className}`}
      style={{
        backgroundColor: flat ? "var(--panel-flat)" : "var(--panel)",
        borderColor:
          borderColor ?? (flat ? "var(--border-flat)" : "var(--border)"),
        boxShadow: borderColor
          ? `0 0 0 1px color-mix(in srgb, ${borderColor} 35%, transparent)`
          : undefined,
      }}
    >
      {badge}
      <div className="flex items-center gap-2">
        {icon}
        <div className="min-w-0">
          <h2
            className="text-[14.5px] font-semibold"
            style={{
              color: flat ? "var(--muted-foreground)" : "var(--foreground)",
            }}
          >
            {accent && !icon && (
              <span
                aria-hidden="true"
                className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-middle"
                style={{ backgroundColor: accent }}
              />
            )}
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-[12px] leading-snug text-dim">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
      {stripRows && <InOutStrip rows={stripRows} />}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Hot / cold path frames

   The boundary sits at the GATEWAY'S RIGHT EDGE, not the network edge —
   relay push and export drain are off-hot threads, so the hot path ends at
   the ring hand-off inside the C++ process, before the wire. This is
   deliberate and correct; do not move it to the exchange<->gateway or
   gateway<->relay wire.

   Both used to be a thin rail strip floating above the row, disconnected
   from the cards they actually described. HOT PATH became HotPathFrame,
   wrapping L2DataCapture directly (a single node, so a JSX wrapper around
   its own content was enough). COLD PATH covers relay -> viewer -> browser
   — three SEPARATE React Flow nodes, which a JSX wrapper can't span. Cold
   PathBackdrop is instead its own background NODE, sized to enclose all
   three, given a negative zIndex so it renders behind them (see its entry
   in ARCHITECTURE_NODES) — the cards sit visually "inside" it the same way
   L2DataCapture sits inside its own frame, just via layering instead of
   nesting.
   ──────────────────────────────────────────────────────────────────────── */

// Padding beyond relay's left edge / browser's right edge — same idea as
// HotPathFrame's own px-2 (8px) breathing room between its border and the
// card inside. Was 20: wide enough that the frame's left edge reached INTO
// the gateway<->relay gap, where the "ws /ingest" edge label lives — the
// label (up to ~110px wide, centred in a 130px gap) can come within ~10px
// of relay's own edge, so a 20px pad put the frame's border squarely
// through the middle of that label. 8 keeps the frame's border behind
// where any label in that gap can reach (see the gateway-relay edge's own
// labelOffset in edges.tsx, pulled further toward gateway for the same
// reason) instead of one straddling the other.
const COLD_FRAME_PAD_X = 8;
export const COLD_FRAME_X = COL_X.relay - COLD_FRAME_PAD_X;
export const COLD_FRAME_WIDTH =
  COL_X.browser + END_CAP_WIDTH + COLD_FRAME_PAD_X - COLD_FRAME_X;
// Taller than PIPELINE_ROW_HEIGHT on purpose: the viewer<->relay /health
// link dips BELOW the pipeline row (its "underArc" routing), and its label
// sits right at the bottom of that dip — if the frame's own height matches
// the row height exactly, its bottom border lands right through the
// middle of that arc and its label, same class of bug as the left-edge
// one above. Re-derived from PIPELINE_ROW_HEIGHT/RELAY_HEIGHT/
// VIEWER_HEIGHT below: relay's own bottom edge, once centred, sits at
// roughly 650 - (650-570)/2 ≈ 610, the arc dips ~54 past that (~664), and
// the label needs another ~18px below the dip — 720 clears that with room
// to spare. Nudge this if the arc/label still pokes through the bottom
// border.
const COLD_FRAME_HEIGHT = 720;

/** Background frame for relay/viewer/browser — renders BEHIND those three
 * nodes (negative zIndex), sized to enclose them with room at the top for
 * the COLD PATH label. Styled at the exact same opacities as HotPathFrame
 * (border 45%, fill 4%, badge fill 20-22%, description text solid, not
 * muted) — a single saturated colour (COLOR.offHotLight, now a real blue,
 * not the old washed-out grey) reused throughout, same as HOT PATH reuses
 * COLOR.hot. That reuse is what actually reads as "not washed out": grey
 * at these opacities looks faint no matter what; a saturated colour
 * doesn't. */
function ColdPathBackdropNode() {
  return (
    <div
      className="relative rounded-[14px]"
      style={{
        width: COLD_FRAME_WIDTH,
        height: COLD_FRAME_HEIGHT,
        border: `1px dashed color-mix(in srgb, ${COLOR.offHotLight} 45%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${COLOR.offHotLight} 4%, transparent)`,
      }}
    >
      <div className="absolute inset-x-2 top-2 flex items-center gap-2 overflow-hidden">
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide"
          style={{
            color: COLOR.offHotLight,
            backgroundColor: `color-mix(in srgb, ${COLOR.offHotLight} 20%, transparent)`,
          }}
        >
          COLD PATH
        </span>
        <span
          className="truncate text-[11px]"
          style={{ color: COLOR.offHotLight }}
        >
          drained by separate threads · relay push, export drain, disk capture,
          fan-out and render — a stall here can never reach the hot path
        </span>
      </div>
    </div>
  );
}

/** Wraps L2DataCapture directly: a padded dashed-red frame with the HOT
 * PATH label + description sitting in its own reserved strip at the top,
 * like a fieldset legend — the label is now physically part of the same
 * shape as the card it describes, not a separate element floating above
 * it with a gap in between. */
function HotPathFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative rounded-[14px] pt-[76px]"
      style={{
        border: `1px dashed color-mix(in srgb, ${COLOR.hot} 45%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${COLOR.hot} 4%, transparent)`,
      }}
    >
      {/* Was one row (badge + description side by side) with the
          description truncated to a single line — at this card's width
          plus the larger text size, that left almost no room for the
          description before it clipped to "...". Stacked instead: badge on
          its own line, description below wraps across the full card width.
          At this width the description actually wraps to THREE lines, not
          two — pt-18 (was pt-14, itself was pt-9) reserves room for that;
          PIPELINE_ROW_HEIGHT below was bumped to match, since this is the
          card that defines it, and the gap below it (DISK_LABEL_GAP) is
          measured from THAT height — an undersized pt/height here is
          exactly what let the "mmap · CSV · gzip" label sit on top of this
          card's own bottom edge instead of below it. */}
      <div className="absolute inset-x-2 top-2 flex flex-col gap-1">
        <span
          className="w-fit shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide"
          style={{
            color: COLOR.hot,
            backgroundColor: `color-mix(in srgb, ${COLOR.hot} 20%, transparent)`,
          }}
        >
          HOT PATH
        </span>
        <span className="text-[11px] leading-snug" style={{ color: COLOR.hot }}>
          real-time cores · ingest → parse → ring → book →{" "}
          <code className="font-mono">rdtscp</code> stamp · never blocks, never
          waits on I/O
        </span>
      </div>
      <div className="px-2 pb-2">{children}</div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Pipeline — five stages, left to right. Content trimmed to the most
   important implementation fact per stage — no per-row metadata pills.
   ──────────────────────────────────────────────────────────────────────── */

function ExchangeNode() {
  return (
    <div style={{ width: END_CAP_WIDTH }}>
      <H type="source" position={Position.Right} id="right-source" />
      <Card
        title="Hyperliquid"
        subtitle="source · external"
        icon={
          <StageIcon
            glyph={<GlyphCircleLines />}
            color={COLOR.accentTeal}
            delayIndex={0}
          />
        }
        stripRows={[{ key: "out", value: "JSON frames, wire order" }]}
      >
        <Group
          cols={1}
          tagColor={COLOR.accentTeal}
          items={[
            ["trades", "1 socket"],
            ["l2Book", "1 socket"],
            ["l2Book nSigFigs 4/3/2", "3 sockets"],
            ["No delta protocol", "full reseed"],
          ]}
        />
      </Card>
    </div>
  );
}

function GatewayNode() {
  return (
    <div style={{ width: STAGE_WIDTH }}>
      <H type="target" position={Position.Left} id="left-target" />
      <H type="source" position={Position.Right} id="right-source" />
      <H type="source" position={Position.Bottom} id="bottom-source" />
      <HotPathFrame>
        <Card
          title="L2DataCapture"
          subtitle="capture · normalise · build book"
          icon={
            <StageIcon glyph="C++" color={COLOR.accentBlue} delayIndex={1} />
          }
          stripRows={[
            { key: "in", value: "depth & trade frames · 5 sockets" },
            {
              key: "out",
              value:
                "snapshot · coarse_snapshot · trade · sample + capture files",
            },
          ]}
        >
          <Group
            label="Ingest"
            cols={1}
            tagColor={COLOR.accentBlue}
            items={[
              ["WS frame arrives · TLS 1.3", "blocking read"],
              ["t_recv = rdtscp()", "before parse"],
              ["simdjson On-Demand", "wire order"],
              ["parse_scaled → int64", "px×1e4 · qty×1e3"],
            ]}
          />
          <Group
            label="Queue · hand-off"
            cols={1}
            tagColor={COLOR.accentBlue}
            items={[
              ["SpscRingBuffer<Tick,1024> ×2", "depth · trades"],
              ["Full ring → drop + count", "never blocks"],
            ]}
          />
          <Group
            label="Consumer · book build"
            cols={1}
            tagColor={COLOR.accentBlue}
            items={[
              ["Seed / sync state machine", "Init→Syncing→InSync"],
              ["OrderBook apply_depth", "2M slots + bitmap"],
              ["CoarseBookState", "tiers {4,3,2}"],
              ["rdtscp stamps", "pop · book · publish"],
            ]}
          />
          <Group
            label="Publish · hand-off to off-hot drains"
            cols={1}
            tagColor={COLOR.accentBlue}
            items={[
              ["RelayPushClient", "2,048 slots"],
              ["MmapWriter → ticks.bin", "per tick"],
              ["Export ring → ColdPathExporter", "65,536 slots"],
              ["LiveHistogram", "ratio 1.01"],
            ]}
          />
        </Card>
      </HotPathFrame>
    </div>
  );
}

function RelayNode() {
  return (
    <div style={{ width: STAGE_WIDTH }}>
      <H type="target" position={Position.Left} id="left-target" />
      <H type="source" position={Position.Right} id="right-source" />
      <H type="target" position={Position.Bottom} id="bottom-target" />
      <Card
        title="l2-gateway-relay"
        subtitle="fan-out & aggregation"
        icon={
          <StageIcon
            glyph={<GlyphHexagon />}
            color={COLOR.accentGreen}
            delayIndex={2}
          />
        }
        stripRows={[
          { key: "in", value: "live WS from the gateway only" },
          { key: "out", value: "/live fan-out · 1 Hz stats · /health" },
        ]}
      >
        <Group
          label="Ingest · /ingest"
          cols={1}
          tagColor={COLOR.accentGreen}
          items={[
            ["Upstream gateway link", "WS server"],
            ["Token handshake", "INGEST_TOKEN"],
            ["Heartbeat", "15 s · 2 missed"],
          ]}
        />
        <Group
          label="Fan-out · /live"
          cols={1}
          tagColor={COLOR.accentGreen}
          items={[
            ["Broadcaster", "serialize once"],
            ["ConnectionManager", "up to 500 clients"],
            ["Backpressure", "drop >1 MB"],
            ["Over capacity", "close 1013"],
          ]}
        />
        <Group
          label="Aggregation · latency"
          cols={1}
          tagColor={COLOR.accentGreen}
          items={[
            ["TSC → ns", "÷ cpu_ghz"],
            ["4-stage split", "parse·queue·book·pub"],
            ["10 s buckets × 360", "1 h window"],
            ["Geometric histogram", "1.01 · 2³¹ ns cap"],
          ]}
        />
        <Group
          label="Health"
          cols={1}
          tagColor={COLOR.accentGreen}
          items={[
            ["GET /health", "200 / 503"],
            ["GET /stats", "rolling snapshot"],
          ]}
        />
      </Card>
    </div>
  );
}

function ViewerNode() {
  return (
    <div style={{ width: STAGE_WIDTH }}>
      <H type="target" position={Position.Left} id="left-target" />
      <H type="source" position={Position.Right} id="right-source" />
      <H type="source" position={Position.Bottom} id="bottom-source" />
      <Card
        title="Web viewer"
        subtitle="subscribe · decode · render"
        icon={<StageIcon glyph="N" color={COLOR.accentViolet} delayIndex={3} />}
        stripRows={[
          { key: "in", value: "/live records + stats" },
          { key: "out", value: "book · tape · latency charts" },
        ]}
      >
        <Group
          label="Data · useRelayConnection"
          cols={1}
          tagColor={COLOR.accentViolet}
          items={[
            ["WebSocket client", "/live"],
            ["Message types", "hello·snap·coarse·trade·stats"],
            ["Per-sample TSC → ns", "LiveSample"],
            ["Exponential reconnect", "+ /health poll"],
            ["heatmapBins", "mirrors histogram"],
          ]}
        />
        <Group
          label="UI · Dashboard"
          cols={1}
          tagColor={COLOR.accentViolet}
          items={[
            ["FeedStatusBanner", "feed state"],
            ["InstrumentSelect", "BTC · xyz:CL"],
            ["TradesTape", "live trades"],
            ["LatencyPanel", "ECharts"],
            ["useECharts", "rAF-coalesced"],
          ]}
        />
      </Card>
    </div>
  );
}

function BrowserNode() {
  return (
    <div style={{ width: END_CAP_WIDTH }}>
      <H type="target" position={Position.Left} id="left-target" />
      <Card
        title="Browser"
        subtitle="sink · trader"
        icon={
          <StageIcon
            glyph={<GlyphPerson />}
            color={COLOR.accentPink}
            delayIndex={4}
          />
        }
        stripRows={[{ key: "in", value: "relay only — never the exchange" }]}
      >
        <Group
          cols={1}
          tagColor={COLOR.accentPink}
          items={[
            ["Receives", "/live stream"],
            ["Polls", "/health"],
            ["Sees", "book · tape"],
            ["Sees", "latency charts"],
          ]}
        />
      </Card>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Supporting engineering cards — placed directly under the pipeline stage
   they belong to, not as an independent section.
   ──────────────────────────────────────────────────────────────────────── */

interface CaptureFile {
  name: string;
  desc: string;
  owner: string;
}
const CAPTURE_FILES: readonly CaptureFile[] = [
  {
    name: "ticks.bin",
    desc: "Memory-mapped, 64 B packed NormalizedTick records, 10M pre-allocated",
    owner: "MmapWriter",
  },
  {
    name: "latency.csv",
    desc: "Per-stage samples: queue, parse, book_update, publish (ns)",
    owner: "LatencyStore",
  },
  {
    name: "session_<ms>.ndjson.gz",
    desc: "gzip NDJSON of every export record, same schema as the live stream",
    owner: "ColdPathExporter",
  },
];

/** Sits under L2DataCapture — joined to it by the disk link. */
function CaptureSinkNode() {
  return (
    <div style={{ width: STAGE_WIDTH }}>
      <H type="target" position={Position.Top} id="top-target" />
      <Card
        title="Capture sink"
        subtitle="written by the gateway · terminal, not a source"
        badge={<CornerBadge text="WRITE-ONLY" color={COLOR.offHotLight} />}
      >
        {/* Was grid-cols-1 sm:grid-cols-3 — sm: is a VIEWPORT breakpoint,
            not a container query, so it forced 3 columns based on browser
            width regardless of how narrow this card itself is (300px after
            the STAGE_WIDTH cut), squeezing 3 file entries into slivers.
            Plain single-column, unconditionally. */}
        <ul className="grid grid-cols-1 gap-1">
          {CAPTURE_FILES.map((f) => (
            <li
              key={f.name}
              className="rounded-[7px] border border-border/70 bg-muted px-2 py-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] font-medium text-foreground">
                  {f.name}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                {f.desc}
              </div>
              <div className="mt-0.5 font-mono text-[10.5px] text-dim">
                {f.owner}
              </div>
            </li>
          ))}
        </ul>
        <Note>
          Nothing reads these back at runtime — the relay is fed only by the
          live <code className="font-mono">/ingest</code> socket, so capture can
          stall or be deleted without touching the live path.
        </Note>
      </Card>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Latency instrumentation — sits in the supporting row, to the right of
   Capture Sink, filling whatever width is left over to the canvas's own
   right edge. Used to be a separate full-width card below everything;
   moved up here once Backpressure/WhySplit were removed, since that left
   this exact stretch of the supporting row empty right next to Capture
   Sink. No section heading/number; just the card itself. Stages preserved
   exactly: parse -> queue -> book-update -> publish.
   ──────────────────────────────────────────────────────────────────────── */

// How far left of Gateway's own edge Capture Sink sits (tune this to move
// Capture Sink left/right). At 320, Capture Sink's X range (60 to 360)
// overlaps Hyperliquid's column (30 to 250) — that's fine, NOT a visual
// collision, because they're nowhere near each other vertically: Hyperliquid
// sits up in the pipeline row, Capture Sink sits far below it, past
// PIPELINE_ROW_HEIGHT. Only matters if Capture Sink's own Y ever moves up
// close to the pipeline row's Y range.
const CAPTURE_SINK_X_NUDGE = 320;
const CAPTURE_SINK_X = COL_X.gateway - CAPTURE_SINK_X_NUDGE;
// Latency card starts right after Capture Sink's own right edge (+ a
// normal ROW_GAP) and fills every remaining pixel out to the canvas's
// right edge (the same edge Browser's column ends on) — NOT a fixed/small
// width matched to Capture Sink's own 300px. If Capture Sink's position or
// width ever changes, this recomputes automatically.
const LATENCY_CARD_X = CAPTURE_SINK_X + STAGE_WIDTH + ROW_GAP;
const LATENCY_CARD_WIDTH = CANVAS_WIDTH - LATENCY_CARD_X;
// Vertical position, relative to Y_supporting (Capture Sink's own Y, set
// further down near ARCHITECTURE_NODES) — this is the ONLY knob for
// moving this card up/down. 0 = flush top-aligned with Capture Sink.
const LATENCY_CARD_Y_NUDGE = 82;

const TIMELINE_WIDTH = LATENCY_CARD_WIDTH - 96;
const SEGMENT_WIDTH = TIMELINE_WIDTH / 4;

const STAMPS = [
  { id: "t_recv", label: "frame received" },
  { id: "t_parse", label: "parsed, enqueued" },
  { id: "t_pop", label: "dequeued" },
  { id: "t_book", label: "book applied" },
  { id: "t_publish", label: "written" },
] as const;
// Halo delays land each stamp's flash at 0/25/50/75/99% of the 11s loop —
// the last one is 99%, not 100%, so it doesn't collide with the reset.
const HALO_DELAYS_S = [0, 2.75, 5.5, 8.25, 10.89];

const PHASES = [
  {
    key: "parse",
    color: COLOR.accentBlue,
    interval: "t_recv → t_parse",
    text: "simdjson reads the frame in wire order and parse_scaled turns prices and sizes into fixed-point int64.",
  },
  {
    key: "queue",
    color: COLOR.accentTeal,
    interval: "t_parse → t_pop",
    text: "The tick sits in the lock-free SPSC ring until the consumer thread picks it up. This is the stage that grows first under load.",
  },
  {
    key: "book-update",
    color: COLOR.accentViolet,
    interval: "t_pop → t_book",
    text: "apply_depth writes the level into the 2M-slot book and refreshes the coarse {4,3,2} tiers.",
  },
  {
    key: "publish",
    color: COLOR.accentPink,
    interval: "t_book → t_publish",
    text: "The record is handed to the relay push ring and to the capture writers. The hot path is done here.",
  },
] as const;

function LatencyInstrumentationNode() {
  return (
    <div style={{ width: LATENCY_CARD_WIDTH }}>
      <Card
        title="Latency Timeline"
        subtitle="The chip is that sample crossing the gateway, handed on at each stamp — taking the colour and name of
          the phase it entered. Every ring flashes as rdtscp is read; each bar stays filled until the journey
          restarts."
        icon={<StageIcon glyph="?" color={COLOR.accentAmber} delayIndex={0} />}
      >
        {/* ── The timeline ── */}
        <div
          style={{ width: TIMELINE_WIDTH, marginInline: "auto" }}
          className="relative pt-5 pb-2"
        >
          {/* Bar row — track, fill bars, AND stamp markers/halos are all
              scoped to THIS one relative wrapper, not the big outer
              pt-5/pb-2 stack (which also holds the label row and phase-name
              row below). They used to be direct children of that outer
              stack and positioned with `top-1/2 -translate-y-1/2`, which
              centres against the FULL height of whatever contains them —
              with the label/phase rows also inside that same stack, "50%"
              landed roughly in the middle of the LABEL row (~54px down),
              not on the ~8px bar near the top. The dim track line and the
              marker dots were floating at that wrong height, drawn right
              across "t_parse"/"t_pop"/etc's own text — this wrapper is
              exactly the bar's own box, so top-1/2 inside it now means
              what it always looked like it should mean. */}
          <div className="relative h-2 w-full overflow-visible rounded-full bg-muted">
            {/* dim full-width track */}
            <div
              className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-border"
              aria-hidden="true"
            />

            {/* four interval bars, filling in sequence and holding */}
            <div className="relative flex h-full w-full overflow-visible rounded-full">
              {PHASES.map((phase, i) => (
                <div
                  key={phase.key}
                  className="relative h-full flex-1 overflow-hidden first:rounded-l-full last:rounded-r-full"
                >
                  <div
                    className={`tf-bar tf-bar-${i + 1} h-full`}
                    style={{ backgroundColor: phase.color }}
                  />
                </div>
              ))}
            </div>

            {/* stamp markers + halos */}
            {STAMPS.map((stamp, i) => (
              <div
                key={stamp.id}
                className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                style={{ left: i * SEGMENT_WIDTH }}
              >
                <span
                  className="tf-stamp-halo absolute h-3 w-3 rounded-full border"
                  style={
                    {
                      borderColor: "var(--foreground)",
                      ["--tf-halo-delay" as string]: `${HALO_DELAYS_S[i]}s`,
                    } as React.CSSProperties
                  }
                  aria-hidden="true"
                />
                <span
                  className="h-2 w-2 rounded-full border border-background bg-foreground"
                  aria-hidden="true"
                />
              </div>
            ))}
          </div>

          {/* travelling sample chips — one per phase, visible only in its own quarter */}
          {PHASES.map((phase, i) => (
            <div
              key={phase.key}
              className={`tf-chip tf-chip-${i + 1} pointer-events-none absolute top-[-8px] flex items-center gap-1 rounded-full border px-1.5 py-0.5`}
              style={
                {
                  left: i * SEGMENT_WIDTH,
                  ["--seg" as string]: `${SEGMENT_WIDTH}px`,
                  borderColor: `color-mix(in srgb, ${phase.color} 55%, transparent)`,
                  backgroundColor: "var(--panel)",
                  color: phase.color,
                } as React.CSSProperties
              }
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: phase.color }}
              />
              <span className="font-mono text-[10px] font-semibold whitespace-nowrap">
                {phase.key}
              </span>
            </div>
          ))}

          {/* stamp id / description labels. Positioned EXACTLY like the
              stamp markers above (absolute, left: i * SEGMENT_WIDTH) —
              this used to be a flex row where each of the 5 labels was
              given a full SEGMENT_WIDTH width, but there are only 4
              segments: 5 * SEGMENT_WIDTH is 125% of the actual timeline
              width, so the row overflowed its container and every label's
              position silently drifted from its marker's true position —
              worst on t_recv (the first, left-anchored one), which is why
              it visibly sat over the track line instead of under its dot. */}
          <div className="relative mt-5" style={{ height: 32 }}>
            {STAMPS.map((stamp, i) => {
              const isFirst = i === 0;
              const isLast = i === STAMPS.length - 1;
              return (
                <div
                  key={stamp.id}
                  className={`absolute top-0 flex flex-col whitespace-nowrap ${isFirst ? "items-start text-left" : isLast ? "items-end text-right" : "items-center text-center"}`}
                  style={{
                    left: i * SEGMENT_WIDTH,
                    transform: isFirst
                      ? "translateX(0)"
                      : isLast
                        ? "translateX(-100%)"
                        : "translateX(-50%)",
                  }}
                >
                  <span className="font-mono text-[12px] text-foreground">
                    {stamp.id}
                  </span>
                  <span className="mt-0.5 text-[10.5px] leading-tight text-dim">
                    {stamp.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* segment name row, centred under each bar */}
          <div className="mt-2 flex w-full">
            {PHASES.map((phase) => (
              <div
                key={phase.key}
                className="flex-1 text-center font-mono text-[11px] font-medium"
                style={{ color: phase.color }}
              >
                {phase.key}
              </div>
            ))}
          </div>
        </div>

        {/* ── Phase descriptions — four columns ── */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {PHASES.map((phase) => (
            <div
              key={phase.key}
              className="border-l-2 py-0.5 pl-2.5"
              style={{ borderColor: phase.color }}
            >
              <div
                className="font-mono text-[12px] font-semibold"
                style={{ color: phase.color }}
              >
                {phase.key}
              </div>
              <div className="mt-0.5 font-mono text-[10.5px] text-dim">
                {phase.interval}
              </div>
              <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
                {phase.text}
              </p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Registration + layout
   ──────────────────────────────────────────────────────────────────────── */

// memo: every one of these cards runs its own CSS animation (bar fills,
// travelling chips, icon pings, stamp halos), several of them sharing the
// SAME clock (e.g. the latency card's bar/chip/halo elements are all keyed
// to the same 11s loop and have to stay in lockstep). `Wrapped` takes no
// props it actually reads — but a bare `memo()` with no comparator still
// falls back to React's default SHALLOW comparison of whatever props
// React Flow happens to pass a node (position, `selected`, `dragging`,
// zIndex...), and React Flow re-computes several of those on nearly every
// internal update (pan, zoom, clicking anywhere selectable). Every one of
// those was quietly re-rendering every "static" card, and on a re-render
// each animated element gets a BRAND NEW inline style object — which some
// browsers treat as reason enough to restart that one element's animation
// clock, even though every computed value in it is unchanged. Different
// elements don't all get re-triggered by the exact same event in the exact
// same instant, so their clocks drift apart independently — which is
// exactly what "the bar/chip/halo don't line up any more" looks like: the
// underlying keyframe math (checked above) was always correct; the
// elements just kept getting knocked out of phase with each other. The
// second argument to `memo` below (`() => true`) makes the comparator
// ALWAYS report "props are equal" — so `Wrapped` renders exactly once,
// ever, and nothing React Flow does to a node's props can touch its DOM
// (or its running animations) again.
function wrap(
  Component: ComponentType,
): (props: NodeProps) => React.ReactElement {
  const Wrapped = memo(
    function Wrapped() {
      return <Component />;
    },
    () => true,
  );
  Wrapped.displayName = Component.name;
  return Wrapped as unknown as (props: NodeProps) => React.ReactElement;
}

export const nodeTypes: NodeTypes = {
  coldPathBackdrop: wrap(ColdPathBackdropNode),
  exchange: wrap(ExchangeNode),
  gateway: wrap(GatewayNode),
  relay: wrap(RelayNode),
  viewer: wrap(ViewerNode),
  browser: wrap(BrowserNode),
  captureSink: wrap(CaptureSinkNode),
  latencyInstrumentation: wrap(LatencyInstrumentationNode),
};

function n(
  id: string,
  type: string,
  x: number,
  y: number,
  zIndex?: number,
): Node {
  return { id, type, position: { x, y }, data: {}, draggable: false, zIndex };
}

// Row Y positions — MEASURED against the real rendered cards (React Flow
// auto-measures each node's true height; these decide how much clearance
// the next row gets), stacked with exactly ROW_GAP between every row. No
// numbered band headers (and no separate rail strip — both hot and cold
// path are now frames wrapping their own cards, see above) exist any more,
// so the chain starts directly at the pipeline row.
//
// Measured content heights at the current column widths (read back via
// getBoundingClientRect()/zoom on the actually-rendered page). Whenever a
// card's content changes enough to change its height, these need
// re-tuning — that's what let the supporting row (Capture sink etc.)
// overlap the pipeline row once already, and it's the same class of bug if
// left stale here again.
//
// All four figures below (PIPELINE_ROW_HEIGHT/RELAY_HEIGHT/VIEWER_HEIGHT/
// END_CAP_HEIGHT) are ESTIMATES from row-counting, not fresh live
// measurements. Bumped by ~20-30px each on top of the row-count estimate:
// narrowing STAGE_WIDTH/END_CAP_WIDTH (see that comment) means the in/out
// strip's longer lines wrap onto one more line than before, and the
// strip's own reserved space grew (pb-10 -> pb-14) to match — both add a
// little height on top of pure row-counting. Nudge these (and
// COLD_FRAME_HEIGHT above, and the per-card Y offsets derived from these
// below) if the row looks cramped or the gap under it looks off.
//   pipeline row (tallest = gateway, wrapped, 14 rows) ~650
//   relay (13 rows)                                     570
//   viewer (10 rows)                                     456
//   end-cap height (exchange/browser, 4 rows)            247
//   supporting row: Capture Sink is ~280 tall; the latency card beside it
//   is taller, but neither height drives any further layout math any
//   more — nothing sits below this row, so whichever is tallest just
//   determines where the canvas's own bounding box ends (React Flow's
//   fitView measures that directly; nothing here needs to precompute it).
// 650 -> 670 -> 690: HotPathFrame's header grew from one row (badge +
// truncated description) to a badge line plus a full-width description
// that wraps to THREE lines at this width — each bump here matches the
// frame's own pt-9 -> pt-14 -> pt-[76px] above. Re-check this pairing
// again if the description's wording or the card's width ever changes.
const PIPELINE_ROW_HEIGHT = 690;
const RELAY_HEIGHT = 570;
const VIEWER_HEIGHT = 456;
const END_CAP_HEIGHT = 247;

// Vertically centres a pipeline card of `height` against the row's
// tallest card (gateway). This did NOT exist for gateway/relay/viewer
// before — only the two end-caps were centred — on the assumption that
// the three "systems this project builds" cards were all roughly the same
// height. That assumption broke the moment gateway got wrapped in
// HotPathFrame and grew ~120px taller than relay/viewer: with all three
// still placed at the same top Y, their HANDLES (which React Flow anchors
// to each node's own vertical centre) landed at three different heights,
// so every "row" edge between them was quietly diagonal instead of level.
// No amount of nudging a label's offset can compensate for a genuinely
// sloped line — this is the actual fix, not another offset tweak.
const centerOffset = (height: number) => (PIPELINE_ROW_HEIGHT - height) / 2;

// Top margin only — there's no rail strip above the pipeline row any more
// (HOT PATH lives on L2DataCapture's own frame, COLD PATH on the backdrop
// behind relay/viewer/browser), so this is just clearance from the canvas
// edge, not a row height + gap chain.
const Y_pipelineTop = ROW_GAP;
// Disk edge (gateway -> Capture sink) carries a two-line label in the gap
// between them — the normal ROW_GAP (30) isn't tall enough to hold an
// arrow AND a label without either clipping into gateway's frame above or
// Capture sink's card below. This transition alone gets a wider channel,
// though the smallest one that still fits: the label box is a two-line
// (now 10.5px + 9.5px, after the architecture-wide text bump) stack in a
// px-2 py-1.5 pill, roughly 40px tall total, and it sits vertically
// CENTRED in this gap — so shrinking the gap below ~44px starts clipping
// the label's own top/bottom padding into gateway's frame above or
// Capture Sink's card below. This had been set to 1 (basically zero gap),
// which is exactly what put the "mmap · CSV · gzip" label on top of
// L2DataCapture's own strip — 44 is the floor that actually fits it, with
// a couple of px of breathing room either side.
const DISK_LABEL_GAP = 44;
const Y_supporting = Y_pipelineTop + PIPELINE_ROW_HEIGHT + DISK_LABEL_GAP;
// Capture Sink's X position (CAPTURE_SINK_X, CAPTURE_SINK_X_NUDGE) and the
// latency card's X/width (LATENCY_CARD_X/LATENCY_CARD_WIDTH) are defined
// up near LatencyInstrumentationNode itself now — the latency card's own
// internal timeline math needs them at module-eval time, before this
// point in the file, so they moved up there together as one geometry
// block instead of staying split across two ends of the file.

// End-caps (Hyperliquid, Browser) are short and vertically centred against
// the tall cards sharing their row.
const END_CAP_Y_OFFSET = centerOffset(END_CAP_HEIGHT);

export const ARCHITECTURE_NODES: Node[] = [
  // Cold path backdrop — a background frame behind relay/viewer/browser,
  // negative zIndex so it renders BEHIND them (the pipeline cards below
  // are given an explicit positive zIndex for the same reason: relying on
  // array order alone is fragile, an explicit stacking order isn't).
  n("coldPathBackdrop", "coldPathBackdrop", COLD_FRAME_X, Y_pipelineTop, -1),

  // Pipeline — five stages, left to right. Every card is centred against
  // the row's tallest (gateway) so all five handles land on the SAME
  // horizontal line — see centerOffset's own comment for why this matters.
  n("exchange", "exchange", COL_X.exchange, Y_pipelineTop + END_CAP_Y_OFFSET),
  n("gateway", "gateway", COL_X.gateway, Y_pipelineTop),
  n(
    "relay",
    "relay",
    COL_X.relay,
    Y_pipelineTop + centerOffset(RELAY_HEIGHT),
    1,
  ),
  n(
    "viewer",
    "viewer",
    COL_X.viewer,
    Y_pipelineTop + centerOffset(VIEWER_HEIGHT),
    1,
  ),
  n("browser", "browser", COL_X.browser, Y_pipelineTop + END_CAP_Y_OFFSET, 1),

  // Supporting engineering card — sits directly under Gateway, the stage
  // it belongs to. Backpressure/Why-the-path-is-split used to sit under
  // relay/viewer here too; both were removed, so this row now holds only
  // Capture Sink.
  n("captureSink", "captureSink", CAPTURE_SINK_X, Y_supporting),

  // Latency instrumentation — sits in the SAME row as Capture Sink, to its
  // right, filling the rest of the canvas's width, nudged down a little
  // (LATENCY_CARD_Y_NUDGE) so it doesn't sit flush top-aligned with
  // Capture Sink. No heading of its own.
  n(
    "latencyInstrumentation",
    "latencyInstrumentation",
    LATENCY_CARD_X,
    Y_supporting + LATENCY_CARD_Y_NUDGE,
  ),
];
