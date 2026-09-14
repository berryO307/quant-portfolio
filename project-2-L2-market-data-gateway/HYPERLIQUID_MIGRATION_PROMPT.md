# Migration prompt: multi-instrument Hyperliquid adapter (+ Bybit kept as a source)

Status: revised per follow-up request — dropdown of several major Hyperliquid
listings (not just one oil contract), backed by an adapter architecture so
future source swaps don't require rewiring the gateway. This is the document
being reviewed before implementation starts; once confirmed, this becomes
the actual migration work.

## What changed from the first draft

The original ask was "switch to Hyperliquid, show oil." The revised ask is
bigger and better-shaped: build the gateway so **which exchange, and which
instrument** are both swappable through one clean seam, ship a curated
dropdown of several liquid Hyperliquid instruments (oil included), and never
have to repeat this rewiring exercise for the next source change.

## Instrument shortlist (real data, pulled from Hyperliquid's own
`metaAndAssetCtxs` on 2026-09-14 — not a guess)

Native markets, ranked by 24h notional volume:

| Symbol | 24h volume | Open interest | Mark px |
|---|---|---|---|
| BTC | $1.72B | 36,681 | 77,704.0 |
| ETH | $1.23B | 1,027,356 | 2,519.7 |
| HYPE | $328M | 20,932,432 | 79.65 |
| SOL | $130M | 5,239,202 | 101.41 |
| XRP | $90M | 151,957,600 | 1.3873 |

Oil, via the `xyz` (Trade[XYZ]) builder-deployed sub-dex — the **only** oil
sub-dex with real activity, confirmed below:

| Symbol | 24h volume | Open interest | Mark px |
|---|---|---|---|
| `xyz:CL` (WTI) | $205M | 2,366,102 | 99.38 |
| `xyz:BRENTOIL` (Brent) | $115M | 2,534,408 | 103.28 |

**Important negative finding, worth recording so it isn't re-litigated
later**: `flx:OIL`, `flx:GAS`, `km:USOIL`, `km:USENERGY`, and `cash:WTI` were
all checked the same way (`{"type":"metaAndAssetCtxs","dex":"<name>"}`) and
every one of them showed **`dayNtlVlm: 0` and `openInterest: 0`** — dead
listings, not real markets to build against. `xyz` is the only viable oil
source on Hyperliquid right now.

**Suggested default dropdown (7 instruments)**: BTC, ETH, SOL, XRP, HYPE,
`xyz:CL`, `xyz:BRENTOIL`. All seven confirmed liquid from the same query;
easy to trim to 5 or extend later since the list lives in one config array,
not scattered through the code (that's the point of this redesign).

## Architecture: adapter pattern for the market data source

**The problem with today's `WsClient` ([include/ws_client.hpp](include/ws_client.hpp), [src/ws_client.cpp](src/ws_client.cpp))**:
it IS the Bybit protocol. `WS_HOST`, the subscribe-message JSON shape, the
`topic`/`data`/`u`-sequence parsing in `dispatch()`/`parse_depth()` — all of
it is Bybit-specific and none of it is behind an interface. Adding
Hyperliquid today means either a parallel copy-pasted class (duplication,
two things to maintain) or branching inside the existing one (the thing
you're explicitly trying to avoid — "if we change source again, rewire
everything").

**The fix — extract the seam that's already almost there.** `WsClient`'s
constructor and `run(symbol, stream_suffix)` signature ([include/ws_client.hpp:23-30](include/ws_client.hpp#L23))
already take its dependencies by reference and get invoked identically for
both channels in `main.cpp` ([src/main.cpp:469](src/main.cpp#L469), [:484](src/main.cpp#L484)).
That shape becomes an interface:

```cpp
// include/market_data_source.hpp
enum class Channel { Depth, Trades };

class IMarketDataSource {
public:
    virtual ~IMarketDataSource() = default;
    // Connect, subscribe to `channel` for this source's configured
    // instrument, and run the read loop until stop_flag is set.
    virtual void run(Channel channel) = 0;
};
```

- `Channel` replaces today's Binance-flavored `stream_suffix` string
  (`"@depth@100ms"`, `"@aggTrade"`) — those are Bybit/Binance-wire artifacts
  leaking into the call site; a plain enum is source-agnostic, and each
  adapter maps it to whatever its own subscribe topic actually looks like.
- `BybitAdapter` = today's `WsClient`, renamed, implementing the interface —
  its internals (host, subscribe JSON, `parse_depth`/`parse_agg_trade`)
  don't change at all. This is a rename-and-wrap, not a rewrite.
- `HyperliquidAdapter` = new class, same interface, own host
  (`api.hyperliquid.xyz/ws`, to be confirmed against live docs at
  implementation time), own subscribe shape
  (`{"method":"subscribe","subscription":{"type":"l2Book","coin":"<symbol>"}}`
  — again confirmed live, not assumed), own parser. Both adapters normalize
  into the *same* `Tick`/`DepthUpdate`/`PriceLevel` types already flowing
  through the ring buffer — `OrderBook`, `ColdPathExporter`, the export
  schema, the relay, and the web layer see zero difference between sources.
  This is the actual point of the pattern: Open/Closed — a third source
  later is a third class, not a change to these two or to anything
  downstream.
- A small factory owns the only place that branches on source:

  ```cpp
  struct MarketDataSourceConfig {
      enum class Exchange { Bybit, Hyperliquid } exchange;
      std::string symbol; // "btcusdt" for Bybit; "xyz:CL" for a Hyperliquid sub-dex
  };

  std::unique_ptr<IMarketDataSource> make_market_data_source(
      const MarketDataSourceConfig& cfg,
      SpscRingBuffer<Tick, 1024>& queue, std::atomic<bool>& stop_flag,
      LatencyStore& latency, std::atomic<uint64_t>& last_u);
  ```

  `main.cpp` gains a `--source=bybit|hyperliquid` argument (default
  `bybit`, so today's invocation — `./quant_day1.exe 3 btcusdt` — keeps
  working with zero behavior change), builds the config, and calls the
  factory in place of `WsClient client(...)` at both call sites
  ([src/main.cpp:469](src/main.cpp#L469), [:484](src/main.cpp#L484)).
  Each adapter owns interpreting its own symbol string — the factory
  passes it through untouched, so `btcusdt` vs `xyz:CL`'s different
  addressing schemes are each adapter's own problem, not the factory's.

- Hot-path rule ([CLAUDE.md](CLAUDE.md)) is unaffected either way: each
  adapter runs on its own dedicated I/O thread exactly like `WsClient` does
  today, handing off through the same lock-free ring buffer. The adapter
  pattern doesn't touch that boundary — it only reorganizes what sits on
  the producer side of it.

## Architecture: how the web dropdown actually gets live data

This is a real fork, not a detail — worth deciding explicitly rather than
discovering the hard way mid-build.

**Recommended: one gateway process per instrument, unchanged single-symbol
design.** Run N `quant_day1` processes concurrently (one per dropdown
entry), each with its own `--source`/symbol and its own relay instance on
its own port — exactly today's process model, just N copies of it. The web
dropdown doesn't reconfigure a running gateway; it switches which relay
WS URL the browser connects to (`web/src/lib/config.ts` gains an
`INSTRUMENTS` list of `{ id, label, symbol, wsUrl, healthUrl, priceScale,
qtyScale }` instead of one hardcoded `TICKER_SYMBOL`/relay URL). Zero
hot-path changes, zero wire-format changes, because each gateway process
still only ever knows about one instrument, same as it does right now.

**The alternative** — one gateway process multiplexing several symbols
over one WS connection, tagging every `Tick`/`ExportRecord` with a symbol
field — would touch the hot path (symbol-keyed book state, a schema change
to `Tick`/`ExportRecord`/the NDJSON format) for a benefit (fewer OS
processes) that doesn't matter at this project's scale. Rejected for that
reason unless a concrete need for it shows up later.

Practical note: 7 concurrent gateway+relay pairs is 7 WS connections out to
Hyperliquid/Bybit and 7 small node processes — trivial for a dev machine,
just worth knowing before scripting it up as a `start-all.sh` rather than
7 manual terminal launches.

## What changes, file by file

**New — [include/market_data_source.hpp](include/market_data_source.hpp)
/ `src/market_data_source_factory.cpp`**: the interface and factory above.

**[include/ws_client.hpp](include/ws_client.hpp) / [src/ws_client.cpp](src/ws_client.cpp)**:
renamed to `BybitAdapter`, implements `IMarketDataSource`. Internal logic
(`WS_HOST`, `dispatch()`, `parse_depth()`, `parse_agg_trade()`,
`trigger_resync()`) is untouched — this is a wrap, not a rewrite.

**New — `include/hyperliquid_adapter.hpp` / `src/hyperliquid_adapter.cpp`**:
mirrors `BybitAdapter`'s shape against Hyperliquid's actual WS protocol
(host, subscribe message, `l2Book`/trade message parsing, snapshot vs.
delta semantics — Hyperliquid's delta/resync model needs to be read from
their live docs at implementation time and re-derived properly, not
assumed to resemble Bybit's `u`-sequence scheme just because both are
"an orderbook feed").

**[src/main.cpp](src/main.cpp)**: `--source` argument, factory call at the
two `WsClient client(...)` sites, otherwise unchanged (duration/symbol args
stay as they are).

**[src/rest_client.cpp](src/rest_client.cpp)**: whatever Bybit REST calls
this makes today need a Hyperliquid equivalent if any adapter needs a REST
seed/fallback — same interface-extraction treatment if so.

**Relay** — no changes needed to `relay/src/types.ts`/`index.ts` beyond
running N instances (one per gateway process, distinct ports). This is the
hot-path/UI split in [CLAUDE.md](CLAUDE.md) paying off: the relay only
ever sees the already-normalized `ExportRecord`/`Tick` shapes, so it
neither knows nor cares which upstream exchange fed a given instance.

**Web**:
- `web/src/lib/config.ts`: `TICKER_SYMBOL` + single relay URL replaced by
  an `INSTRUMENTS: InstrumentConfig[]` list (id, label, symbol, relay WS/
  health URLs, `priceScale`/`qtyScale`). Per-instrument scale is required,
  not optional — BTC (~77,000), XRP (~1.39), and WTI (~99) need different
  decimal handling; a single global `PRICE_SCALE`/`QTY_SCALE` constant
  (currently in `web/src/lib/types.ts`) stops being correct the moment a
  second instrument with a different magnitude is addable from the same
  UI.
- New `InstrumentSelect` dropdown (same pattern as the just-built
  `DepthLevelSelect` in `DepthCurve.tsx`), wired wherever the relay
  connection is established, switching the active `wsUrl` + scale config
  together when changed.
- `use24hChange.ts`: **resolved, not just flagged** — Hyperliquid's
  `{"type":"metaAndAssetCtxs"[,"dex":"<name>"]}` response carries both
  `markPx` and `prevDayPx` per instrument (confirmed live: BTC's context
  has `"markPx":"77704.0","prevDayPx":"76775.0"`), so 24h % change is a
  plain `(markPx - prevDayPx) / prevDayPx` computed from the same call used
  to build the instrument list — no separate ticker endpoint, and it works
  identically for native and `xyz`-scoped instruments. Bybit-sourced
  instruments keep using the existing `api.bybit.com` ticker call. The hook
  becomes source-aware (branches on which adapter the active instrument
  uses), same shape as the C++ side's factory branch.
- Ladder/depth-curve decimal formatting (`toFixed(4)`/`toFixed(2)`/
  `toFixed(3)` in `OrderBookLadder.tsx`/`DepthCurve.tsx`) needs to read
  from the active instrument's scale config rather than the hardcoded
  precision tuned for BTC's magnitude.

**Versioning**: breaking change to the source/symbol addressing scheme and
to `web/src/lib/config.ts`'s public shape → MAJOR bump under
`project-2-vMAJOR.MINOR.PATCH` ([CLAUDE.md](CLAUDE.md)).

## Suggested PR breakdown (small, single-purpose, per CLAUDE.md)

1. `feature/market-data-source-adapter` — extract `IMarketDataSource`,
   rename `WsClient`→`BybitAdapter` with zero behavior change, add the
   factory defaulting to Bybit. Verified by confirming the existing
   capture flow still produces identical output to before the rename.
2. `feature/hyperliquid-adapter` — new `HyperliquidAdapter` for one
   instrument (`xyz:CL`, since it's the most-liquid oil listing found),
   verified with a short real capture the same way the Bybit real-data
   pipeline was verified earlier this project.
3. `feature/web-instrument-config` — `INSTRUMENTS` list + per-instrument
   scale/formatting, still pointed at a single instrument by default (no
   dropdown yet) — isolates the scale-constant rework from the UI change.
4. `feature/instrument-dropdown` — the actual `InstrumentSelect` UI,
   `use24hChange` source-branching, and the `start-all` script for running
   N gateway+relay pairs. Last, since it depends on 1-3 all landing first.
5. Extend the Hyperliquid adapter to the rest of the shortlist (ETH, SOL,
   XRP, HYPE, `xyz:BRENTOIL`) — mechanical once step 2 proves the adapter
   works for one Hyperliquid instrument.

## Remaining open question before starting

Hyperliquid's WS `l2Book` subscription depth/behavior (does it push full
depth updates the same way Bybit's `orderbook.200` does, and what does
resync/snapshot vs. delta actually look like on their wire) is still
unverified — the `/info` REST endpoint used for this document's research
doesn't tell us that; it needs a live WS connection test, which is step 2
above, not something to resolve by reading docs alone (the docs fetch
earlier this session was inconclusive on this exact point).

## Confirmation

This is the plan as it stands. Say go and step 1 starts.
