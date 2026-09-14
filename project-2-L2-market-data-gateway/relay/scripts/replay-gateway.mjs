// Replays a REAL captured session (data/export/session_*.ndjson.gz, written by
// ColdPathExporter — see include/export_pipeline.hpp) to the relay's /ingest
// endpoint, speaking the exact same wire protocol fake-gateway.mjs does. Every
// field already matches what the relay expects verbatim — ColdPathExporter's
// gzprintf output was written specifically to mirror relay/src/types.ts's
// record shapes — so this script's only real job is PACING: converting each
// record's raw TSC value into a real-time delay using the same cpu_ghz the
// capture itself was calibrated at (the C++ process prints this at startup,
// e.g. "Calibrated Host TSC Frequency: 3.80001 GHz" — pass that value in).
//
// Usage: node scripts/replay-gateway.mjs <path-to-session.ndjson.gz> [port=8080] [cpuGhz] [--loop]
// Set INGEST_TOKEN to match the relay's if it's running with one configured.
//
// Without --loop this does exactly one real-time pass through the file and
// then disconnects — by design, matching a real gateway session ending.
// That's also exactly what "the replay stopped working" turned out to be
// the first time this ran for a while: not a bug, just the single pass
// finishing after its ~3 real minutes with nothing restarting it. --loop
// re-runs the same pass indefinitely (re-sending the same "hello" each
// time, same as a real gateway reconnecting) for exactly that reason — a
// standing local data source that doesn't need to be manually relaunched.
import WebSocket from "ws";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const LOOP = args.includes("--loop");
const [filePath, portArg, cpuGhzArg] = args.filter((a) => a !== "--loop");
if (!filePath) {
  console.error("usage: node scripts/replay-gateway.mjs <session.ndjson.gz> [port=8080] [cpuGhz] [--loop]");
  process.exit(1);
}

const PORT = Number(portArg ?? process.env.PORT ?? 8080);
// No universal "right" default — this must match whatever the specific
// capture being replayed was calibrated at, or every stage-latency number
// downstream will be silently wrong. Passing it explicitly is deliberate,
// not an oversight.
const CPU_GHZ = Number(cpuGhzArg ?? process.env.CPU_GHZ ?? 3.8);
const INGEST_TOKEN = process.env.INGEST_TOKEN;
// Any single inter-record gap longer than this is capped, not honored —
// otherwise a real pause in the original capture (e.g. sitting idle for a
// stretch before the book first seeded) would stall the whole replay for
// just as long in real time.
const MAX_GAP_MS = 2_000;

function tscOf(record) {
  return record.type === "sample" ? record.t_recv : record.tsc;
}

async function loadRecords(path) {
  const records = [];
  const stream = createReadStream(path).pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A truncated final line (the capture process was killed mid-write,
      // or this is being replayed while still being recorded) — skip it
      // rather than aborting the whole replay over one partial record.
    }
  }
  return records;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`[replay-gateway] loading ${filePath} ...`);
  const records = await loadRecords(filePath);
  console.log(`[replay-gateway] loaded ${records.length} records`);
  if (records.length === 0) {
    console.error("[replay-gateway] no records to replay");
    process.exit(1);
  }

  const gw = new WebSocket(`ws://localhost:${PORT}/ingest`);

  gw.on("open", () => {
    console.log(
      `[replay-gateway] connected to ws://localhost:${PORT}/ingest — replaying ${records.length} real records at real-time pace (cpu_ghz=${CPU_GHZ}${LOOP ? ", looping" : ""})`
    );
    gw.send(
      JSON.stringify({
        type: "hello",
        cpu_ghz: CPU_GHZ,
        ...(INGEST_TOKEN ? { token: INGEST_TOKEN } : {}),
      })
    );
    void runLoop();
  });

  async function replayOnce() {
    let prevTsc = null;
    let sent = 0;
    for (const record of records) {
      if (gw.readyState !== WebSocket.OPEN) break; // connection dropped mid-pass — stop, don't keep sleeping/sending into nothing
      const tsc = tscOf(record);
      if (prevTsc != null && tsc != null) {
        const deltaMs = Math.max(0, Math.min((tsc - prevTsc) / CPU_GHZ / 1e6, MAX_GAP_MS));
        if (deltaMs > 0) await sleep(deltaMs);
      }
      if (tsc != null) prevTsc = tsc;

      if (gw.readyState === WebSocket.OPEN) {
        gw.send(JSON.stringify(record));
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
        `[replay-gateway] pass ${pass} complete — sent ${sent}/${records.length} records${LOOP ? " (looping)" : ""}`
      );
    } while (LOOP && gw.readyState === WebSocket.OPEN);

    if (!LOOP) gw.close();
  }

  gw.on("error", (e) => console.error("[replay-gateway] error:", e.message));
  gw.on("close", () => {
    console.log("[replay-gateway] disconnected");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[replay-gateway] fatal:", err);
  process.exit(1);
});
