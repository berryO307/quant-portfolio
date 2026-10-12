import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createRelay, type RelayConfig } from "./server.js";

// End-to-end tests against a real relay on a random port: real WebSockets,
// real HTTP, no mocks. The property that matters most for a multi-instrument
// relay is isolation -- one instrument's data must never reach another
// instrument's viewers -- and only a real fan-out path can prove that.

const TOKEN = "test-token";

async function startRelay(overrides: Partial<RelayConfig> = {}) {
  const relay = createRelay({
    corsOrigins: ["*"],
    maxClients: 50,
    maxChannels: 16,
    ingestToken: TOKEN,
    symbols: [],
    statsIntervalMs: 60_000, // keep stats out of the way of message assertions
    helloTimeoutMs: 1_000,
    ...overrides,
  });
  await new Promise<void>((resolve) => relay.server.listen(0, resolve));
  const port = (relay.server.address() as AddressInfo).port;
  return { relay, port, base: `127.0.0.1:${port}` };
}

// A socket plus everything it has received, so assertions can wait for a
// message instead of racing the event.
function open(url: string) {
  const ws = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: String(reason) }))
  );
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  ws.on("error", () => {});
  const opened = new Promise<void>((resolve) => ws.on("open", () => resolve()));
  return { ws, messages, closed, opened };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 2_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Connect a fake data source and send its hello. Waits until the relay has
// attached it, so records sent afterwards aren't dropped.
async function feed(
  base: string,
  relay: { registry: { get(s: string): { source: { isConnected(): boolean } } | undefined } },
  symbol: string,
  extra: Record<string, unknown> = {}
) {
  const src = open(`ws://${base}/ingest`);
  await src.opened;
  src.ws.send(JSON.stringify({ type: "hello", cpu_ghz: 3.0, token: TOKEN, symbol, ...extra }));
  await waitFor(() => relay.registry.get(symbol)?.source.isConnected() === true, `${symbol} attached`);
  return src;
}

const trade = (price: number) => ({ type: "trade", tsc: 1, price, qty: 1, trade_id: price, side: "bid" });
const viewerUrl = (base: string, symbol: string) => `ws://${base}/live?symbol=${encodeURIComponent(symbol)}`;

test("routes each instrument's records only to that instrument's viewers", async () => {
  const { relay, base } = await startRelay();
  try {
    const btcFeed = await feed(base, relay, "BTC");
    const clFeed = await feed(base, relay, "xyz:CL");
    const btcViewer = open(viewerUrl(base, "BTC"));
    const clViewer = open(viewerUrl(base, "xyz:CL"));
    await Promise.all([btcViewer.opened, clViewer.opened]);
    await waitFor(() => btcViewer.messages.length > 0 && clViewer.messages.length > 0, "hellos");

    btcFeed.ws.send(JSON.stringify(trade(100)));
    clFeed.ws.send(JSON.stringify(trade(200)));
    await waitFor(
      () => btcViewer.messages.some((m) => m.type === "trade") && clViewer.messages.some((m) => m.type === "trade"),
      "both trades"
    );

    const prices = (msgs: Record<string, unknown>[]) => msgs.filter((m) => m.type === "trade").map((m) => m.price);
    assert.deepEqual(prices(btcViewer.messages), [100]);
    assert.deepEqual(prices(clViewer.messages), [200]);
    assert.equal(btcViewer.messages[0]?.symbol, "BTC");
    assert.equal(clViewer.messages[0]?.symbol, "xyz:CL");
  } finally {
    await relay.close();
  }
});

test("a new viewer gets the channel's cached snapshot immediately", async () => {
  const { relay, base } = await startRelay();
  try {
    const src = await feed(base, relay, "BTC");
    src.ws.send(JSON.stringify({ type: "snapshot", tsc: 1, bids: [[1, 1]], asks: [[2, 1]] }));
    await new Promise((r) => setTimeout(r, 50));

    const viewer = open(viewerUrl(base, "BTC"));
    await waitFor(() => viewer.messages.length >= 3, "hello + snapshot + stats_full");
    assert.deepEqual(viewer.messages.slice(0, 2).map((m) => m.type), ["hello", "snapshot"]);
  } finally {
    await relay.close();
  }
});

test("rejects /live without a symbol or for an unknown one", async () => {
  const { relay, base } = await startRelay();
  try {
    assert.deepEqual(await open(`ws://${base}/live`).closed, { code: 1008, reason: "symbol query parameter required" });
    assert.deepEqual(await open(viewerUrl(base, "NOPE")).closed, { code: 1008, reason: "unknown symbol" });
    assert.equal(relay.registry.all().length, 0, "a viewer must never create a channel");
  } finally {
    await relay.close();
  }
});

test("pre-declared symbols accept viewers before their feed, health follows the feed", async () => {
  const { relay, base, port } = await startRelay({ symbols: ["BTC"] });
  try {
    const viewer = open(viewerUrl(base, "BTC"));
    await viewer.opened;
    const before = await fetch(`http://127.0.0.1:${port}/health?symbol=BTC`);
    assert.equal(before.status, 503);

    await feed(base, relay, "BTC");
    const after = await fetch(`http://127.0.0.1:${port}/health?symbol=BTC`);
    assert.equal(after.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health?symbol=NOPE`)).status, 404);
  } finally {
    await relay.close();
  }
});

test("ingest needs the token and a valid symbol, and a rejected source creates nothing", async () => {
  const { relay, base } = await startRelay();
  try {
    const badToken = open(`ws://${base}/ingest`);
    await badToken.opened;
    badToken.ws.send(JSON.stringify({ type: "hello", cpu_ghz: 3, token: "wrong", symbol: "BTC" }));
    await badToken.closed;

    const noSymbol = open(`ws://${base}/ingest`);
    await noSymbol.opened;
    noSymbol.ws.send(JSON.stringify({ type: "hello", cpu_ghz: 3, token: TOKEN }));
    assert.equal((await noSymbol.closed).code, 1008);

    const silent = open(`ws://${base}/ingest`); // never sends hello
    await silent.closed; // dropped by helloTimeoutMs

    assert.equal(relay.registry.all().length, 0);
  } finally {
    await relay.close();
  }
});

test("MAX_CLIENTS is one budget across all instruments", async () => {
  const { relay, base } = await startRelay({ maxClients: 2, symbols: ["BTC", "xyz:CL"] });
  try {
    const a = open(viewerUrl(base, "BTC"));
    const b = open(viewerUrl(base, "xyz:CL"));
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => relay.registry.totalViewers() === 2, "two viewers");
    assert.equal((await open(viewerUrl(base, "BTC")).closed).code, 1013);
  } finally {
    await relay.close();
  }
});

test("a replay never displaces a live feed, but live displaces a replay", async () => {
  const { relay, base } = await startRelay();
  try {
    const replay = await feed(base, relay, "BTC", { isReplay: true });
    const live = await feed(base, relay, "BTC");
    await replay.closed; // superseded by the live feed
    assert.equal(relay.registry.get("BTC")?.source.isReplay(), false);

    // The replay retrying while live is up is refused, and live stays attached.
    const retry = open(`ws://${base}/ingest`);
    await retry.opened;
    retry.ws.send(JSON.stringify({ type: "hello", cpu_ghz: 3.0, token: TOKEN, symbol: "BTC", isReplay: true }));
    assert.deepEqual(await retry.closed, { code: 1013, reason: "live feed active" });
    assert.equal(live.ws.readyState, WebSocket.OPEN);
    assert.equal(relay.registry.get("BTC")?.source.isReplay(), false);

    // Once live is gone, the replay is accepted again.
    live.ws.close();
    await live.closed;
    await waitFor(() => relay.registry.get("BTC")?.source.isConnected() === false, "live detached");
    await feed(base, relay, "BTC", { isReplay: true });
    assert.equal(relay.registry.get("BTC")?.source.isReplay(), true);
  } finally {
    await relay.close();
  }
});

test("CORS allowlist echoes a listed origin and omits the header for others", async () => {
  const { relay, port } = await startRelay({ corsOrigins: ["https://app.example", "http://localhost:3000"] });
  try {
    const get = (origin: string) => fetch(`http://127.0.0.1:${port}/symbols`, { headers: { Origin: origin } });
    const allowed = await get("http://localhost:3000");
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(allowed.headers.get("vary"), "Origin");
    const denied = await get("https://evil.example");
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  } finally {
    await relay.close();
  }
});

test("stats: full history once on connect, then only changed buckets, sparse", async () => {
  const { relay, base } = await startRelay({ statsIntervalMs: 100 });
  try {
    const src = await feed(base, relay, "BTC");
    const sample = (i: number) => ({
      type: "sample", t_recv: 1_000 + i, t_parse_begin: 1_000 + i, t_parse: 4_000 + i,
      t_pop: 5_000 + i, t_book: 6_000 + i, t_publish: 7_000 + i, batch_index: 0, batch_size: 1,
    });
    for (let i = 0; i < 5; i++) src.ws.send(JSON.stringify(sample(i)));
    // All five recorded, then the pending change set consumed, so nothing is
    // owed to the viewer below beyond its stats_full.
    const stats = relay.registry.get("BTC")!.stats;
    await waitFor(() => stats.snapshot().currentSession.count === 5, "samples recorded");
    stats.takeUpdate();

    const viewer = open(viewerUrl(base, "BTC"));
    await waitFor(() => viewer.messages.some((m) => m.type === "stats_full"), "stats_full");
    const full = viewer.messages.find((m) => m.type === "stats_full") as {
      binCount: number; latencyBuckets: { total: { count: number; bins: [number, number][] } }[];
    };
    assert.ok(full.binCount > 1000);
    assert.equal(full.latencyBuckets.length, 1);
    assert.equal(full.latencyBuckets[0]!.total.count, 5);
    // Sparse: 5 identical samples land in one bin, not a 1,854-entry array.
    assert.deepEqual(full.latencyBuckets[0]!.total.bins.length, 1);
    assert.ok(!("counts" in full.latencyBuckets[0]!.total));

    // Idle: no samples, so no stats at all (old behaviour: the whole history
    // again every tick).
    await new Promise((r) => setTimeout(r, 350));
    const settled = viewer.messages.filter((m) => m.type === "stats_update").length;
    assert.equal(settled, 0, "idle relay sends no stats");
    // A new sample: one update carrying only the changed bucket.
    src.ws.send(JSON.stringify(sample(9)));
    await waitFor(() => viewer.messages.filter((m) => m.type === "stats_update").length > settled, "stats_update");
    const update = viewer.messages.filter((m) => m.type === "stats_update").at(-1) as {
      latencyBuckets: { total: { count: number } }[];
    };
    assert.equal(update.latencyBuckets.length, 1);
    assert.equal(update.latencyBuckets[0]!.total.count, 6);
    assert.ok(viewer.messages.every((m) => m.type !== "stats"), "the old full-every-tick message is gone");
  } finally {
    await relay.close();
  }
});

test("egress budget: once the day's budget is spent, viewers are cut off and refused", async () => {
  // ~21KB budget: a trade is ~74 bytes on the wire, so ~280 of the 600
  // below fit and the rest must not be sent.
  const { relay, base, port } = await startRelay({ egressBudgetMBPerDay: 0.02 });
  // A missing close must fail the test, not hang the suite.
  const within = <T,>(p: Promise<T>, label: string) =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), 3_000))]);
  try {
    const src = await feed(base, relay, "BTC");
    const viewer = open(viewerUrl(base, "BTC"));
    await waitFor(() => viewer.messages.some((m) => m.type === "stats_full"), "viewer onboarded");

    for (let i = 0; i < 600; i++) src.ws.send(JSON.stringify(trade(1_000 + i)));
    assert.deepEqual(await within(viewer.closed, "viewer cut off"), { code: 1013, reason: "daily bandwidth budget reached" });
    const delivered = viewer.messages.filter((m) => m.type === "trade").length;
    assert.ok(delivered > 0 && delivered < 600, `some trades delivered before the cap, not all (${delivered})`);

    // A new viewer the same day is refused outright.
    assert.deepEqual(await within(open(viewerUrl(base, "BTC")).closed, "new viewer refused"), {
      code: 1013,
      reason: "daily bandwidth budget reached",
    });

    // And the relay says why.
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      egress: { sentTodayMB: number; budgetMB: number };
    };
    assert.equal(health.egress.budgetMB, 0.02);
    assert.ok(health.egress.sentTodayMB >= 0.01);
  } finally {
    await relay.close();
  }
});

test("egress budget: 0 means no cap", async () => {
  const { relay, base } = await startRelay({ egressBudgetMBPerDay: 0 });
  try {
    const src = await feed(base, relay, "BTC");
    const viewer = open(viewerUrl(base, "BTC"));
    await waitFor(() => viewer.messages.some((m) => m.type === "stats_full"), "viewer onboarded");
    for (let i = 0; i < 600; i++) src.ws.send(JSON.stringify(trade(1_000 + i)));
    await waitFor(() => viewer.messages.filter((m) => m.type === "trade").length === 600, "all 600 trades");
    assert.equal(viewer.ws.readyState, WebSocket.OPEN);
  } finally {
    await relay.close();
  }
});
