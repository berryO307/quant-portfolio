// Neon-backed counterpart to replay-gateway.mjs: same real-time-pace replay
// against the relay's /ingest endpoint, same wire protocol, but the tick
// data comes from Neon Postgres (loaded there by migrate-to-neon.mjs)
// instead of reading a .ndjson.gz file directly.
//
// Driver choice matters here in a way it doesn't for migrate-to-neon.mjs:
// this is a long-running process (run under systemd, looping indefinitely),
// and Neon's free tier autosuspends the compute endpoint after a period of
// inactivity. A raw `pg` Client holding one persistent TCP connection would
// need its own reconnect-on-idle handling to survive that. This script
// sidesteps the problem entirely instead of solving it: @neondatabase/
// serverless's HTTP driver (`neon()`) makes each query a stateless HTTPS
// request with no persistent connection to keep alive or drop. Combined
// with loading the WHOLE session into memory in one query at startup (same
// as replay-gateway.mjs reads its whole file into memory up front), the
// only Neon round-trip in this script's entire lifetime is that one
// startup query — after that, the real-time pacing loop below runs purely
// from memory, identical to the file-based version, and Neon is free to
// autosuspend for the rest of the run without affecting anything.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/replay-gateway-neon.mjs --symbol=<SYM> [port=8080] [--loop]
//
// Picks the MOST RECENT session for --symbol (highest captured_at_ms) —
// this project captures one session per instrument at a time, not several
// competing ones, so "latest" is the unambiguous right choice rather than a
// simplification that would need revisiting if that ever changes.
import { neon } from "@neondatabase/serverless";
import WebSocket from "ws";

const args = process.argv.slice(2);
const LOOP = args.includes("--loop");
const symbolArg = args.find((a) => a.startsWith("--symbol="));
const SYMBOL = symbolArg?.slice("--symbol=".length);
const portArg = args.find((a) => !a.startsWith("--") && /^\d+$/.test(a));

if (!SYMBOL || !process.env.DATABASE_URL) {
  console.error(
    "usage: DATABASE_URL=postgres://... node scripts/replay-gateway-neon.mjs --symbol=<SYM> [port=8080] [--loop]"
  );
  process.exit(1);
}

const PORT = Number(portArg ?? process.env.PORT ?? 8080);
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const MAX_GAP_MS = 2_000; // see replay-gateway.mjs's own comment on this constant

const sql = neon(process.env.DATABASE_URL);

function tscOf(record) {
  return record.type === "sample" ? record.t_recv : record.tsc;
}

// Reverses migrate-to-neon.mjs's toRow() — reconstructs the exact wire-shape
// record from a ticks row, dropping the SQL-only columns (session_id, seq,
// record_type) and every column that doesn't apply to this row's type
// (all NULL, per schema.sql's design).
function rowToRecord(row) {
  switch (row.record_type) {
    case "sample":
      return {
        type: "sample",
        t_recv: Number(row.t_recv), t_parse: Number(row.t_parse),
        ...(row.t_pop != null ? { t_pop: Number(row.t_pop) } : {}),
        t_book: Number(row.t_book), t_publish: Number(row.t_publish),
        ...(row.batch_index != null ? { batch_index: row.batch_index } : {}),
        ...(row.batch_size != null ? { batch_size: row.batch_size } : {}),
        ...(row.queue_overflow_dropped != null
          ? { queue_overflow_dropped: Number(row.queue_overflow_dropped) }
          : {}),
        side: row.side,
        cpu_core: row.cpu_core,
      };
    case "snapshot":
      return { type: "snapshot", tsc: Number(row.tsc), bids: row.bids, asks: row.asks };
    case "coarse_snapshot":
      return {
        type: "coarse_snapshot",
        nsigfigs: row.nsigfigs,
        tsc: Number(row.tsc),
        bids: row.bids,
        asks: row.asks,
      };
    case "trade":
      return {
        type: "trade",
        tsc: Number(row.tsc),
        price: Number(row.price),
        qty: Number(row.qty),
        trade_id: Number(row.trade_id),
        side: row.side,
        ...(row.event_time_ms != null ? { event_time_ms: Number(row.event_time_ms) } : {}),
      };
    default:
      return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSession() {
  const sessions = await sql`
    SELECT id, captured_at_ms, cpu_ghz, record_count
    FROM sessions
    WHERE symbol = ${SYMBOL}
    ORDER BY captured_at_ms DESC
    LIMIT 1
  `;
  if (sessions.length === 0) {
    throw new Error(`no session found in Neon for symbol=${SYMBOL} — run migrate-to-neon.mjs first`);
  }
  const session = sessions[0];

  const rows = await sql`
    SELECT record_type, t_recv, t_parse, t_pop, t_book, t_publish,
           batch_index, batch_size, queue_overflow_dropped, cpu_core, side,
           tsc, nsigfigs, bids, asks, price, qty, trade_id, event_time_ms
    FROM ticks
    WHERE session_id = ${session.id}
    ORDER BY seq
  `;

  const records = rows.map(rowToRecord).filter(Boolean);
  return {
    capturedAtMs: Number(session.captured_at_ms),
    cpuGhz: session.cpu_ghz,
    records,
  };
}

async function main() {
  console.log(`[replay-gateway-neon] loading latest session for symbol=${SYMBOL} from Neon...`);
  const { capturedAtMs, cpuGhz, records } = await loadSession();
  console.log(
    `[replay-gateway-neon] loaded ${records.length} records (captured_at_ms=${capturedAtMs}, cpu_ghz=${cpuGhz})`
  );
  if (records.length === 0) {
    console.error("[replay-gateway-neon] no records to replay");
    process.exit(1);
  }

  const gw = new WebSocket(`ws://localhost:${PORT}/ingest`);

  gw.on("open", () => {
    console.log(
      `[replay-gateway-neon] connected to ws://localhost:${PORT}/ingest — replaying ${records.length} records for symbol=${SYMBOL} at real-time pace (cpu_ghz=${cpuGhz}${LOOP ? ", looping" : ""})`
    );
    gw.send(
      JSON.stringify({
        type: "hello",
        cpu_ghz: cpuGhz,
        isReplay: true,
        symbol: SYMBOL,
        capturedAt: capturedAtMs,
        ...(INGEST_TOKEN ? { token: INGEST_TOKEN } : {}),
      })
    );
    void runLoop();
  });

  async function replayOnce() {
    let prevTsc = null;
    let sent = 0;
    for (const record of records) {
      if (gw.readyState !== WebSocket.OPEN) break;
      const tsc = tscOf(record);
      if (prevTsc != null && tsc != null) {
        const deltaMs = Math.max(0, Math.min((tsc - prevTsc) / cpuGhz / 1e6, MAX_GAP_MS));
        if (deltaMs > 0) await sleep(deltaMs);
      }
      if (tsc != null) prevTsc = tsc;

      if (gw.readyState === WebSocket.OPEN) {
        gw.send(JSON.stringify({ ...record, symbol: SYMBOL }));
        sent++;
      }
    }
    return sent;
  }

  async function runLoop() {
    let pass = 0;
    do {
      pass++;
      const sent = await replayOnce();
      console.log(
        `[replay-gateway-neon] pass ${pass} complete — sent ${sent}/${records.length} records${LOOP ? " (looping)" : ""}`
      );
    } while (LOOP && gw.readyState === WebSocket.OPEN);

    if (!LOOP) gw.close();
  }

  gw.on("error", (e) => console.error("[replay-gateway-neon] error:", e.message));
  gw.on("close", () => {
    console.log("[replay-gateway-neon] disconnected");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[replay-gateway-neon] fatal:", err);
  process.exit(1);
});
