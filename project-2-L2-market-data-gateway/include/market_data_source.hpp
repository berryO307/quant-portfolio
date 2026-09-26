#pragma once
#include "types.hpp"
#include "spsc_ring_buffer.hpp"
#include "rdtsc.hpp"
#include <atomic>
#include <memory>
#include <string>

// Adapter seam between the gateway's exchange-agnostic pipeline (ring
// buffer -> OrderBook -> export) and whatever wire protocol a given
// exchange/venue actually speaks. Every adapter normalizes into the same
// Tick/DepthUpdate/AggTrade shapes (types.hpp) regardless of source, so
// OrderBook, ColdPathExporter, the export schema, the relay, and the web
// layer never need to know which venue fed them (CLAUDE.md's hot-path/UI
// split already relied on this same principle one layer downstream).
//
// Channel replaces the old WsClient::run(symbol, stream_suffix) API's
// Binance-flavored suffix strings ("@depth@100ms", "@aggTrade") — those
// were Bybit/Binance wire artifacts leaking into the call site. A plain
// enum is source-agnostic; each adapter maps it to whatever its own
// subscribe topic actually looks like.
//
// CoarseDepth is NOT part of the real trading pipeline — it exists purely
// so the web UI's widest price-bucket views (e.g. BTC's $1000 bucket) have
// real data to aggregate. Depth/Trades subscribe at Hyperliquid's default
// (finest) rounding, which only ever spans a narrow real price range (~$20
// on BTC at the time this was measured) — no amount of client-side
// bucketing of an already-narrow snapshot can manufacture range that isn't
// there. CoarseDepth requests a second, wider-rounded l2Book subscription
// (nSigFigs) from Hyperliquid itself, so the widest buckets aggregate real
// exchange data instead of either collapsing to 1-2 levels or (the
// previous, now-removed approach) coming from a live poll straight from
// the browser to Hyperliquid's REST API, bypassing the gateway entirely.
//
// An adapter running this channel MUST NOT touch the queue/latency/
// OrderBook machinery the other two channels feed — see HyperliquidAdapter's
// own comment on its dispatch() CoarseDepth branch.
enum class Channel { Depth, Trades, CoarseDepth };

class IMarketDataSource {
public:
    virtual ~IMarketDataSource() = default;

    // Connect, subscribe to `channel` for this adapter's configured
    // instrument, and run the read loop until stop_flag (given at
    // construction) is set or the process is torn down. Blocks the calling
    // thread — same contract as WsClient::run() before this refactor, so
    // main.cpp still runs one adapter instance per dedicated I/O thread.
    virtual void run(Channel channel) = 0;
};

// Bybit support (BybitAdapter) was removed after this project moved fully
// to Hyperliquid — see BUGS.md for why "live feed unavailable" kept
// showing up and git history (feature/hyperliquid-adapter) for the earlier
// two-source version, if a second source is ever needed again. Kept as a
// named config struct + factory function (rather than main.cpp directly
// constructing HyperliquidAdapter) so that seam still exists cheaply.
struct MarketDataSourceConfig {
    // A native coin ("BTC") or a builder-deployed sub-dex coin ("xyz:CL")
    // — both subscribe identically over Hyperliquid's WS, confirmed live;
    // the adapter passes this straight through untouched.
    std::string symbol;
};

std::unique_ptr<IMarketDataSource> make_market_data_source(
    const MarketDataSourceConfig& cfg,
    SpscRingBuffer<Tick, 1024>& queue,
    std::atomic<bool>& stop_flag,
    LatencyStore& latency,
    std::atomic<uint64_t>& last_u,
    std::atomic<uint64_t>& queue_overflow_dropped);
