// Feed audit: does what the relay serves for an instrument match what
// Hyperliquid itself publishes?
//
// Opens two connections at once and compares them:
//   - REFERENCE: Hyperliquid's own WebSocket (trades + l2Book), directly.
//   - SUBJECT:   our relay's /live?symbol= stream, i.e. Hyperliquid ->
//                C++ gateway -> relay -> here. Exactly what a browser gets.
//
// Trades are matched one-to-one by Hyperliquid's trade id (tid), so every
// failure is concrete: which trade, what differed. Books are compared by
// update rate and top-of-book agreement.
//
// Reported:
//   trades  missing   - Hyperliquid printed it, the relay never delivered it
//           extra     - the relay delivered a trade Hyperliquid never sent
//           duplicate - the relay delivered the same tid more than once
//           mismatch  - same tid, different price / size / side / time
//           lag       - relay arrival minus direct arrival, per trade
//   book    rate      - updates/s from Hyperliquid vs snapshots/s from us
//           lag       - time until our top of book shows a state Hyperliquid
//                       published, and how many states we never showed
//
// Exit code: 0 clean, 1 trade errors found, 2 could not audit (relay is in
// replay, a connection failed, or the reference feed itself dropped).
//
// Usage:
//   node scripts/audit-feed.mjs --symbol=xyz:CL [--relay=https://host] [--seconds=120]
//                               [--gateway-export=path/to/session_*.ndjson.gz]
//   --relay defaults to http://localhost:8080; https:// is turned into wss://.
//   --gateway-export: the running gateway's own local export file. Each
//     missing trade is then located: never exported by the gateway (lost
//     inside it, between Hyperliquid and its exporter) or exported and lost
//     after it (push client -> relay -> viewer).
//
// Both connections run from the same machine, so "lag" is the extra path
// our data takes (Hyperliquid -> gateway -> relay -> back here) relative to
// receiving it straight from Hyperliquid on this machine. Read its tail with
// care: the gateway has its OWN Hyperliquid connection, and Hyperliquid
// itself delivers one trade to two connections at different times --
// measured on two direct connections from the same machine: p50 14-32ms,
// p99 286-452ms apart. Lag inside that band is Hyperliquid's fan-out, not
// our pipeline. Missing/extra/duplicate/mismatch have no such noise floor.
import WebSocket from "ws";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { gunzipSync, constants as zlibConstants } from "node:zlib";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || "true"];
  })
);
const SYMBOL = args.symbol;
const RELAY = (args.relay ?? "http://localhost:8080").replace(/\/+$/, "").replace(/^http/, "ws");
const SECONDS = Number(args.seconds ?? 120);
if (!SYMBOL || !Number.isFinite(SECONDS) || SECONDS < 20) {
  console.error("usage: node scripts/audit-feed.mjs --symbol=<SYM> [--relay=https://host] [--seconds>=20]");
  process.exit(2);
}

// Wire scales, mirroring include/types.hpp (PRICE_SCALE, QTY_SCALE).
const PRICE_SCALE = 10_000;
const QTY_SCALE = 1_000_000;
const scale = (s, k) => Math.round(Number(s) * k);

// Trades that reached Hyperliquid's feed less than this long before the
// audit ends still get this long to arrive through our path.
const GRACE_MS = 5_000;
// Hyperliquid replays its most recent trades on subscribe; anything before
// this point predates both connections and isn't part of the audit.
const WARMUP_MS = 3_000;

const now = () => performance.timeOrigin + performance.now(); // ms, sub-ms precision
const tStart = now();
const tEnd = tStart + SECONDS * 1000;

// ---- state ---------------------------------------------------------------
const ref = { trades: new Map(), books: [], drops: 0, open: false };
const ours = { trades: new Map(), dupes: [], books: [], hello: null, drops: 0, open: false };
const fatal = [];

const topOf = (bids, asks) => (bids.length && asks.length ? `${bids[0]}/${asks[0]}` : null);

// ---- reference: Hyperliquid directly ---------------------------------------
const hl = new WebSocket("wss://api.hyperliquid.xyz/ws");
let hlPing;
hl.on("open", () => {
  ref.open = true;
  for (const type of ["trades", "l2Book"]) {
    hl.send(JSON.stringify({ method: "subscribe", subscription: { type, coin: SYMBOL } }));
  }
  // Hyperliquid closes a connection it hasn't sent anything on for 60s;
  // a quiet instrument needs this to keep the reference feed complete.
  hlPing = setInterval(() => hl.send(JSON.stringify({ method: "ping" })), 30_000);
});
hl.on("message", (raw) => {
  const at = now();
  const m = JSON.parse(String(raw));
  if (m.channel === "trades") {
    for (const t of m.data) {
      if (!ref.trades.has(t.tid)) ref.trades.set(t.tid, { ...t, at });
    }
  } else if (m.channel === "l2Book") {
    const [bids, asks] = m.data.levels;
    ref.books.push({ at, top: topOf(bids.map((l) => scale(l.px, PRICE_SCALE)), asks.map((l) => scale(l.px, PRICE_SCALE))) });
  }
});
hl.on("close", () => {
  if (now() < tEnd) ref.drops++;
});
hl.on("error", (e) => fatal.push(`hyperliquid: ${e.message}`));

// ---- subject: our relay ----------------------------------------------------
const relayUrl = `${RELAY}/live?symbol=${encodeURIComponent(SYMBOL)}`;
const rl = new WebSocket(relayUrl);
rl.on("open", () => (ours.open = true));
rl.on("message", (raw) => {
  const at = now();
  const m = JSON.parse(String(raw));
  if (m.type === "hello") {
    ours.hello = m;
    if (m.isReplay) {
      fatal.push(`relay is serving a REPLAY for ${SYMBOL}; there is no live feed to audit`);
      finish();
    }
  } else if (m.type === "trade") {
    if (ours.trades.has(m.trade_id)) ours.dupes.push(m.trade_id);
    else ours.trades.set(m.trade_id, { ...m, at });
  } else if (m.type === "snapshot") {
    ours.books.push({ at, top: topOf(m.bids.map((l) => l[0]), m.asks.map((l) => l[0])) });
  }
});
rl.on("close", (code, reason) => {
  if (now() < tEnd) {
    ours.drops++;
    fatal.push(`relay closed early: ${code} ${reason}`);
  }
});
rl.on("error", (e) => fatal.push(`relay: ${e.message}`));

// ---- progress ----------------------------------------------------------------
const progress = setInterval(() => {
  const s = Math.round((now() - tStart) / 1000);
  console.log(
    `[audit] ${SYMBOL} t+${s}s  trades hl=${ref.trades.size} ours=${ours.trades.size}  books hl=${ref.books.length} ours=${ours.books.length}`
  );
}, 10_000);
setTimeout(finish, SECONDS * 1000);

// ---- report ------------------------------------------------------------------
function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}
const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}ms` : "n/a");
const fmtTime = (t) => new Date(t).toISOString().slice(11, 23);

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearInterval(progress);
  clearInterval(hlPing);
  hl.terminate();
  rl.terminate();

  console.log(`\n=== feed audit: ${SYMBOL}  relay=${RELAY}  ${SECONDS}s ===`);
  if (!ref.open) fatal.push("could not connect to Hyperliquid");
  if (!ours.open) fatal.push(`could not connect to ${relayUrl}`);
  if (ref.drops > 0) fatal.push(`reference feed dropped ${ref.drops}x; trade comparison would be incomplete`);
  if (fatal.length > 0) {
    for (const f of fatal) console.log(`CANNOT AUDIT: ${f}`);
    process.exit(2);
  }

  // Audit window, in exchange time.
  const from = tStart + WARMUP_MS;
  const to = tEnd - GRACE_MS;
  const inWindow = (t) => t >= from && t <= to;

  const missing = [];
  const mismatches = [];
  const lags = [];
  let refCount = 0;
  for (const [tid, r] of ref.trades) {
    if (!inWindow(r.time)) continue;
    refCount++;
    const o = ours.trades.get(tid);
    if (!o) {
      missing.push(r);
      continue;
    }
    lags.push(o.at - r.at);
    const diffs = [];
    if (o.price !== scale(r.px, PRICE_SCALE)) diffs.push(`price ours=${o.price / PRICE_SCALE} hl=${r.px}`);
    if (o.qty !== scale(r.sz, QTY_SCALE)) diffs.push(`size ours=${o.qty / QTY_SCALE} hl=${r.sz}`);
    // Hyperliquid "A" = seller was the taker = printed against the bid.
    const side = r.side === "A" ? "bid" : "ask";
    if (o.side !== side) diffs.push(`side ours=${o.side} hl=${r.side}(${side})`);
    if (o.event_time_ms !== undefined && o.event_time_ms !== r.time) diffs.push(`time ours=${o.event_time_ms} hl=${r.time}`);
    if (diffs.length) mismatches.push({ tid, diffs });
  }
  const extra = [...ours.trades.values()].filter((o) => o.event_time_ms !== undefined && inWindow(o.event_time_ms) && !ref.trades.has(o.trade_id));
  lags.sort((a, b) => a - b);

  const windowS = (to - from) / 1000;
  console.log(`\nTRADES (window ${fmtTime(from)}-${fmtTime(to)} UTC, ${windowS.toFixed(0)}s)`);
  console.log(`  hyperliquid ${refCount}   delivered ${refCount - missing.length}   missing ${missing.length}   extra ${extra.length}   duplicate ${ours.dupes.length}   mismatch ${mismatches.length}`);
  console.log(`  lag vs direct  p50 ${ms(pct(lags, 50))}  p90 ${ms(pct(lags, 90))}  p99 ${ms(pct(lags, 99))}  max ${ms(lags.at(-1))}`);
  if (args["gateway-export"] && missing.length > 0) {
    // The file is still being written, so its gzip stream has no end yet:
    // Z_SYNC_FLUSH decodes everything flushed so far instead of throwing.
    const text = gunzipSync(readFileSync(args["gateway-export"]), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString();
    const exported = new Set();
    let horizon = 0; // newest trade time actually flushed to the file so far
    for (const line of text.split("\n")) {
      if (!line.includes('"type":"trade"')) continue;
      try {
        const t = JSON.parse(line);
        exported.add(t.trade_id);
        horizon = Math.max(horizon, t.event_time_ms ?? 0);
      } catch {
        // last line may be cut mid-record
      }
    }
    for (const r of missing) {
      r.where = exported.has(r.tid) ? "after gateway" : r.time > horizon ? "not flushed yet" : "inside gateway";
    }
    const count = (w) => missing.filter((r) => r.where === w).length;
    console.log(
      `  of the missing: ${count("inside gateway")} never exported by the gateway, ${count("after gateway")} exported then lost downstream, ${count("not flushed yet")} past the file's flushed horizon`
    );
  }
  for (const r of missing.slice(0, 15)) {
    console.log(`  MISSING  tid=${r.tid}  ${fmtTime(r.time)}  ${r.side} ${r.sz} @ ${r.px}${r.where ? `  [${r.where}]` : ""}`);
  }
  if (missing.length > 15) console.log(`  ... ${missing.length - 15} more missing`);
  for (const o of extra.slice(0, 10)) console.log(`  EXTRA    tid=${o.trade_id}  ${fmtTime(o.event_time_ms)}`);
  for (const tid of ours.dupes.slice(0, 10)) console.log(`  DUPLICATE tid=${tid}`);
  for (const x of mismatches.slice(0, 10)) console.log(`  MISMATCH tid=${x.tid}  ${x.diffs.join(", ")}`);

  // Book: rate, then how quickly our top of book reaches each state
  // Hyperliquid published (and how many states it never showed at all --
  // expected in small numbers, since we cap snapshots at 10/s).
  const rate = (arr) => arr.filter((b) => b.at >= from && b.at <= to).length / windowS;
  const bookLags = [];
  let skipped = 0;
  let states = 0;
  let prevTop = null;
  for (let i = 0; i < ref.books.length; i++) {
    const r = ref.books[i];
    if (r.at < from || r.at > to || r.top === prevTop || r.top === null) {
      prevTop = r.top ?? prevTop;
      continue;
    }
    prevTop = r.top;
    states++;
    // Next time Hyperliquid's top of book changes again; ours must show
    // this state before then (plus our normal lag) to count as delivered.
    let nextChangeAt = Infinity;
    for (let j = i + 1; j < ref.books.length; j++) {
      if (ref.books[j].top !== r.top) {
        nextChangeAt = ref.books[j].at;
        break;
      }
    }
    const hit = ours.books.find((o) => o.at >= r.at - 50 && o.top === r.top && o.at <= Math.max(nextChangeAt, r.at) + 2_000);
    if (hit) bookLags.push(hit.at - r.at);
    else skipped++;
  }
  bookLags.sort((a, b) => a - b);
  console.log(`\nBOOK`);
  console.log(`  updates/s  hyperliquid ${rate(ref.books).toFixed(2)}   ours ${rate(ours.books).toFixed(2)}`);
  console.log(
    `  top-of-book states ${states}   shown ${states - skipped}   never shown ${skipped} (${states ? ((100 * skipped) / states).toFixed(1) : 0}%)`
  );
  console.log(`  top-of-book lag  p50 ${ms(pct(bookLags, 50))}  p90 ${ms(pct(bookLags, 90))}  p99 ${ms(pct(bookLags, 99))}  max ${ms(bookLags.at(-1))}`);

  const failed = missing.length + extra.length + ours.dupes.length + mismatches.length;
  console.log(`\nRESULT: ${failed === 0 ? "PASS" : `FAIL (${failed} trade errors)`}`);
  process.exit(failed === 0 ? 0 : 1);
}
