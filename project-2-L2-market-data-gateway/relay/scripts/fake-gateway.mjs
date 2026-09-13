// Dev utility: simulates the C++ gateway's push connection so relay/ and
// web/ can be developed and tested without running the full capture stack.
// Speaks the same wire protocol as the real thing would: a hello handshake,
// then sample/snapshot/trade records with the exact field names ColdPathExporter
// writes (see include/export_pipeline.hpp and relay/src/types.ts).
//
// Usage: node scripts/fake-gateway.mjs [relayPort=8080]
import WebSocket from "ws";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const CPU_GHZ = 3.2;

const gw = new WebSocket(`ws://localhost:${PORT}/ingest`);

gw.on("open", () => {
  console.log(`[fake-gateway] connected to ws://localhost:${PORT}/ingest`);
  gw.send(JSON.stringify({ type: "hello", cpu_ghz: CPU_GHZ }));

  // Real gateway sends a snapshot ~1/s (see consumer_loop's
  // t_last_export_snapshot timer) — resend periodically, not just once, so
  // a browser client connecting later still sees one within ~1s instead of
  // only whenever the gateway happens to have sent its one-shot snapshot.
  setInterval(() => {
    gw.send(JSON.stringify({
      type: "snapshot",
      tsc: Date.now(),
      bids: [[425000000, 12000], [424990000, 8000], [424980000, 5000]],
      asks: [[425010000, 9000], [425020000, 6000], [425030000, 15000]],
    }));
  }, 1000);

  let tradeId = 0;
  setInterval(() => {
    tradeId++;
    gw.send(JSON.stringify({
      type: "trade",
      tsc: 1_000_000_000 + tradeId * 1000,
      price: 425000000 + (tradeId % 5) * 1000,
      qty: 500 + tradeId * 10,
      trade_id: tradeId,
      side: tradeId % 2 === 0 ? "bid" : "ask",
    }));
  }, 300);

  let sampleId = 0;
  setInterval(() => {
    sampleId++;
    const tRecv = 1_000_000_000 + sampleId * 50_000;
    gw.send(JSON.stringify({
      type: "sample",
      t_recv: tRecv,
      t_parse: tRecv + 9600,
      t_book: tRecv + 14400,
      t_publish: tRecv + 16960,
      queue_depth: 2,
      host_jitter_ns: 12,
      side: "bid",
      cpu_core: 3,
    }));
  }, 100);
});

gw.on("error", (e) => console.error("[fake-gateway] error:", e.message));
gw.on("close", () => console.log("[fake-gateway] disconnected"));
