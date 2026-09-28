// One-shot loader: reads a captured .ndjson.gz session (written by
// ColdPathExporter — see include/export_pipeline.hpp) and loads it into
// Neon Postgres per schema.sql, tagged with the symbol it was captured for.
//
// This is a short-lived batch job, not a long-running service — a plain
// `pg` Client (not the Neon serverless HTTP driver used by
// replay-gateway-neon.mjs) is the right tool here: one connection, a batch
// of INSERTs, then exit. The connection-lifecycle concerns that rule out a
// raw client for a long-running process (autosuspend, idle drops) don't
// apply to a script that finishes in seconds.
//
// The source .ndjson.gz file is NOT deleted or modified by this script, and
// isn't meant to be afterwards either — see relay/README.md's Neon section
// for why it stays the durable cold backup / source of truth even once its
// data is queryable from Neon.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-to-neon.mjs <session.ndjson.gz> --symbol=<SYM> --cpu-ghz=<GHZ>
//
// --cpu-ghz is required for the same reason replay-gateway.mjs requires it
// today: it's calibrated per-capture (quant_day1.exe's "Calibrated Host TSC
// Frequency" startup log line) and there's no honest universal default.
//
// Re-running this against the same file is a safe no-op: sessions is keyed
// UNIQUE(symbol, captured_at_ms), so a second run for the same session
// hits ON CONFLICT and updates in place rather than duplicating rows (the
// ticks table is cleared and reloaded for that session_id first).
import { Client } from "pg";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { basename } from "node:path";

const args = process.argv.slice(2);
const symbolArg = args.find((a) => a.startsWith("--symbol="));
const cpuGhzArg = args.find((a) => a.startsWith("--cpu-ghz="));
const filePath = args.find((a) => !a.startsWith("--"));
const SYMBOL = symbolArg?.slice("--symbol=".length);
const CPU_GHZ = cpuGhzArg ? Number(cpuGhzArg.slice("--cpu-ghz=".length)) : undefined;

if (!filePath || !SYMBOL || !CPU_GHZ || !process.env.DATABASE_URL) {
  console.error(
    "usage: DATABASE_URL=postgres://... node scripts/migrate-to-neon.mjs <session.ndjson.gz> --symbol=<SYM> --cpu-ghz=<GHZ>"
  );
  process.exit(1);
}

const filenameMatch = /session_(\d+)\.ndjson\.gz$/.exec(basename(filePath));
if (!filenameMatch) {
  console.error(
    `[migrate] fatal: couldn't parse a capture timestamp from "${basename(filePath)}" (expected session_<epoch_ms>.ndjson.gz)`
  );
  process.exit(1);
}
const CAPTURED_AT_MS = Number(filenameMatch[1]);

// BATCH_SIZE: rows per multi-row INSERT. 500 * ~18 columns is comfortably
// under Postgres's 65535-parameter-per-statement limit (~9000 params/batch)
// with room to spare, and keeps round-trips low for a session with tens of
// thousands of records without building one enormous statement.
const BATCH_SIZE = 500;

function tscOf(record) {
  return record.type === "sample" ? record.t_recv : record.tsc ?? null;
}

async function* readRecords(path) {
  const stream = createReadStream(path).pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Truncated final line (capture killed mid-write) — skip, same
      // tolerance replay-gateway.mjs's loadRecords() already applies.
    }
  }
}

// Maps one wire-shaped record (relay/src/types.ts) to a ticks row, in
// schema.sql's column order, minus session_id/seq (added by the caller).
function toRow(record) {
  const base = {
    record_type: record.type,
    t_recv: null, t_parse: null, t_pop: null, t_book: null, t_publish: null,
    batch_index: null, batch_size: null, queue_overflow_dropped: null, cpu_core: null,
    side: null, tsc: null, nsigfigs: null, bids: null, asks: null,
    price: null, qty: null, trade_id: null, event_time_ms: null,
  };
  switch (record.type) {
    case "sample":
      return {
        ...base,
        t_recv: record.t_recv, t_parse: record.t_parse, t_pop: record.t_pop ?? null,
        t_book: record.t_book, t_publish: record.t_publish,
        batch_index: record.batch_index ?? null, batch_size: record.batch_size ?? null,
        queue_overflow_dropped: record.queue_overflow_dropped ?? null,
        side: record.side, cpu_core: record.cpu_core,
      };
    case "snapshot":
    case "coarse_snapshot":
      return {
        ...base,
        tsc: record.tsc,
        nsigfigs: record.type === "coarse_snapshot" ? record.nsigfigs : null,
        bids: JSON.stringify(record.bids),
        asks: JSON.stringify(record.asks),
      };
    case "trade":
      return {
        ...base,
        tsc: record.tsc, side: record.side, price: record.price, qty: record.qty,
        trade_id: record.trade_id, event_time_ms: record.event_time_ms ?? null,
      };
    default:
      return null;
  }
}

const ROW_COLUMNS = [
  "session_id", "seq", "record_type",
  "t_recv", "t_parse", "t_pop", "t_book", "t_publish",
  "batch_index", "batch_size", "queue_overflow_dropped", "cpu_core", "side",
  "tsc", "nsigfigs", "bids", "asks",
  "price", "qty", "trade_id", "event_time_ms",
];

async function insertBatch(client, sessionId, batch) {
  if (batch.length === 0) return;
  const values = [];
  const placeholders = batch
    .map((row, i) => {
      const cols = [sessionId, row.seq, ...ROW_COLUMNS.slice(2).map((c) => row[c])];
      values.push(...cols);
      const base = i * ROW_COLUMNS.length;
      return `(${ROW_COLUMNS.map((_, j) => `$${base + j + 1}`).join(",")})`;
    })
    .join(",");
  await client.query(
    `INSERT INTO ticks (${ROW_COLUMNS.join(",")}) VALUES ${placeholders}`,
    values
  );
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log(`[migrate] ${basename(filePath)} -> symbol=${SYMBOL} captured_at_ms=${CAPTURED_AT_MS}`);

    const upsert = await client.query(
      `INSERT INTO sessions (symbol, captured_at_ms, cpu_ghz, source_file)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (symbol, captured_at_ms)
       DO UPDATE SET cpu_ghz = EXCLUDED.cpu_ghz, source_file = EXCLUDED.source_file, loaded_at = now()
       RETURNING id`,
      [SYMBOL, CAPTURED_AT_MS, CPU_GHZ, basename(filePath)]
    );
    const sessionId = upsert.rows[0].id;

    // Re-running for the same session must not duplicate rows — clear any
    // previously-loaded ticks for this session_id before reloading.
    const deleted = await client.query("DELETE FROM ticks WHERE session_id = $1", [sessionId]);
    if (deleted.rowCount > 0) {
      console.log(`[migrate] session ${sessionId} already had ${deleted.rowCount} ticks — replacing`);
    }

    let seq = 0;
    let batch = [];
    let skipped = 0;
    for await (const record of readRecords(filePath)) {
      const row = toRow(record);
      if (!row) {
        skipped++;
        continue;
      }
      batch.push({ ...row, seq });
      seq++;
      if (batch.length >= BATCH_SIZE) {
        await insertBatch(client, sessionId, batch);
        batch = [];
      }
    }
    await insertBatch(client, sessionId, batch);

    await client.query("UPDATE sessions SET record_count = $1 WHERE id = $2", [seq, sessionId]);

    console.log(
      `[migrate] loaded ${seq} ticks into session ${sessionId}${skipped > 0 ? ` (skipped ${skipped} unrecognized records)` : ""}`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate] fatal:", err);
  process.exit(1);
});
