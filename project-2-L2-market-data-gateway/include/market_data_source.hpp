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
enum class Channel { Depth, Trades };

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

// The only place that branches on which exchange to talk to. Adding a
// third source later means a third case here (and a third adapter class)
// — nothing in main.cpp, OrderBook, or downstream needs to change.
struct MarketDataSourceConfig {
    enum class Exchange { Bybit, Hyperliquid } exchange = Exchange::Bybit;
    // Bybit: "btcusdt"-style (case-insensitive, adapter uppercases it).
    // Hyperliquid: a native coin ("BTC") or a builder-deployed sub-dex
    // coin ("xyz:CL") — both subscribe identically over Hyperliquid's WS,
    // confirmed live; the adapter passes this straight through untouched.
    std::string symbol;
};

std::unique_ptr<IMarketDataSource> make_market_data_source(
    const MarketDataSourceConfig& cfg,
    SpscRingBuffer<Tick, 1024>& queue,
    std::atomic<bool>& stop_flag,
    LatencyStore& latency,
    std::atomic<uint64_t>& last_u);
