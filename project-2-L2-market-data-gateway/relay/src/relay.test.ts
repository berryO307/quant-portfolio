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
    corsOrigin: "*",
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
async function feed(base: string, relay: { registry: { get(s: string): { source: { isConnected(): boolean } } | undefined } }, symbol: string) {
  const src = open(`ws://${base}/ingest`);
  await src.opened;
  src.ws.send(JSON.stringify({ type: "hello", cpu_ghz: 3.0, token: TOKEN, symbol }));
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
    await waitFor(() => viewer.messages.length >= 2, "hello + snapshot");
    assert.deepEqual(viewer.messages.map((m) => m.type), ["hello", "snapshot"]);
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
