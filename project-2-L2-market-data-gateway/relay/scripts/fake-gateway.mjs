// Dev utility: simulates the C++ gateway's push connection so relay/ and
// web/ can be developed and tested without running the full capture stack.
// Speaks the same wire protocol as the real thing would: a hello handshake,
// then sample/snapshot/trade records with the exact field names ColdPathExporter
// writes (see include/export_pipeline.hpp and relay/src/types.ts).
//
// Usage: node scripts/fake-gateway.mjs [relayPort=8080]
// Set INGEST_TOKEN to match the relay's if it's running with one configured.
import WebSocket from "ws";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const CPU_GHZ = 3.2;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const gw = new WebSocket(`ws://localhost:${PORT}/ingest`);

gw.on("open", () => {
  console.log(`[fake-gateway] connected to ws://localhost:${PORT}/ingest`);
  gw.send(JSON.stringify({
    type: "hello",
    cpu_ghz: CPU_GHZ,
    ...(INGEST_TOKEN ? { token: INGEST_TOKEN } : {}),
  }));

  // Real gateway sends a snapshot ~1/s (see consumer_loop's
  // t_last_export_snapshot timer) — resend periodically, not just once, so
  // a browser client connecting later still sees one within ~1s instead of
  // only whenever the gateway happens to have sent its one-shot snapshot.
  //
  // The book itself used to be a hardcoded constant — same 6 levels,
  // forever. Fine for wiring up the pipe, but it meant the depth curve
  // (and the "current price" ticker) could never look alive, which made a
  // real UI bug (Phase 8.5) look like a data bug too. A small random walk
  // on the mid-price plus per-level size jitter keeps it a stub — nobody
  // should mistake this for real market data — while actually moving.
  const TICK = 10_000; // PRICE_SCALE-native — $1.00 per level (types.hpp)
  const LEVELS = 6;
  let midPriceTicks = 425_000_000;

  function buildLevels(direction) {
    // direction: -1 for bids (descending from one tick below mid),
    // +1 for asks (ascending from one tick above mid) — leaves room for a
    // visible spread instead of the two sides touching at the mid price.
    const levels = [];
    let price = midPriceTicks + direction * TICK;
    for (let i = 0; i < LEVELS; i++) {
      const size = Math.max(500, Math.round(3000 + (Math.random() - 0.5) * 4000));
      levels.push([price, size]);
      price += direction * TICK;
    }
    return levels;
  }

  setInterval(() => {
    // Mostly drifts by zero or one tick per second; occasionally two, so
    // the walk doesn't feel perfectly uniform.
    const step = Math.round((Math.random() - 0.5) * 2.4) * TICK;
    midPriceTicks += step;

    gw.send(JSON.stringify({
      type: "snapshot",
      tsc: Date.now(),
      bids: buildLevels(-1),
      asks: buildLevels(1),
    }));
  }, 1000);

  // Was a fixed 5-price sawtooth with unboundedly growing size (tradeId*10,
  // forever) — deterministic and, past a few minutes, absurd-looking.
  // Trades now print near the same moving mid-price the book uses, with a
  // bounded, randomized size.
  let tradeId = 0;
  setInterval(() => {
    tradeId++;
    const side = Math.random() < 0.5 ? "bid" : "ask";
    const priceJitter = Math.round((Math.random() - 0.5) * 2) * TICK;
    gw.send(JSON.stringify({
      type: "trade",
      tsc: 1_000_000_000 + tradeId * 1000,
      price: midPriceTicks + priceJitter,
      qty: Math.max(100, Math.round(2000 + (Math.random() - 0.5) * 3000)),
      trade_id: tradeId,
      side,
    }));
  }, 300);

  // Randomized with occasional injected spikes (a book-update stall, a host
  // jitter spike) so anything downstream that flags/attributes tail events
  // (the web app's LatencyPanel) actually has something to detect — fixed
  // deltas every time would never cross a p99.9 threshold. Each duration is
  // clamped to a positive floor: a real pipeline stage never takes negative
  // time, and an unclamped jitter term here could otherwise produce one.
  // Sent every 5ms (~200/s) — well under the real gateway's throughput, but
  // fast enough to fill the client's rolling buffer in test runs; a live
  // p99.9 threshold needs >1000 buffered samples before it can differ from
  // the buffer's max at all (below that, "top 0.1%" rounds down to zero
  // samples), which the real system's much higher rate reaches in under a
  // second regardless.
  let sampleId = 0;
  setInterval(() => {
    sampleId++;
    const tRecv = 1_000_000_000 + sampleId * 50_000;
    const jitter = () => Math.round((Math.random() - 0.5) * 1000);

    let parseNs = Math.max(200, 3000 + jitter());
    let bookNs = Math.max(200, 1500 + jitter());
    let publishNs = Math.max(200, 800 + jitter());
    let hostJitterNs = 10 + Math.round(Math.random() * 10);

    const roll = Math.random();
    if (roll < 0.01) {
      bookNs *= 40; // book-update stall — latency inflated, jitter reading stays normal
    } else if (roll < 0.02) {
      // Host jitter spike: the OS preempts this thread mid-stage, which
      // both shows up as elevated host_jitter_ns AND delays whichever stage
      // was running — inflating only host_jitter_ns without also delaying a
      // stage would make this sample's overall latency normal, so it could
      // never cross the p99.9 tail threshold in the first place and the
      // host_jitter attribution path would never be exercised.
      hostJitterNs = 200_000 + Math.round(Math.random() * 100_000);
      publishNs += hostJitterNs * 2; // clearly larger than a book-update stall, so it reliably clears p99.9 too
    }

    const tParse = tRecv + Math.round(parseNs * CPU_GHZ);
    const tBook = tParse + Math.round(bookNs * CPU_GHZ);
    const tPublish = tBook + Math.round(publishNs * CPU_GHZ);

    gw.send(JSON.stringify({
      type: "sample",
      t_recv: tRecv,
      t_parse: tParse,
      t_book: tBook,
      t_publish: tPublish,
      queue_depth: 2,
      host_jitter_ns: hostJitterNs,
      side: "bid",
      cpu_core: 3,
    }));
  }, 5);
});

gw.on("error", (e) => console.error("[fake-gateway] error:", e.message));
gw.on("close", () => console.log("[fake-gateway] disconnected"));
