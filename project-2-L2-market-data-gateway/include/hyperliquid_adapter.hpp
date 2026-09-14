#pragma once
#include "types.hpp"
#include "spsc_ring_buffer.hpp"
#include "rdtsc.hpp"
#include "market_data_source.hpp"
#include <simdjson.h>
#include <string>
#include <atomic>
#include <chrono>

// Synchronous Boost.Beast WSS client for Hyperliquid's public WS API
// (wss://api.hyperliquid.xyz/ws). Same threading/connection-lifecycle shape
// as BybitAdapter — one instance per dedicated I/O thread, run() blocks
// until stop_flag is set — but a materially different wire protocol:
//
// - l2Book pushes a FULL BOOK SNAPSHOT on every message (confirmed live —
//   there is no delta/resync sequence-number protocol at all, unlike
//   Bybit's orderbook.200 stream). Every DepthUpdate this adapter produces
//   therefore has pu=0 ("this is a snapshot" — see OrderBook::apply_depth,
//   which already treats that as an unconditional reseed) and u/U set from
//   Hyperliquid's own message timestamp (monotonically increasing per
//   coin, confirmed live, used only as a strictly-increasing marker — the
//   book doesn't need real sequence continuity when every message is
//   already a complete reseed).
// - A builder-deployed sub-dex coin ("xyz:CL") subscribes identically to a
//   native coin ("BTC") — confirmed live, no separate "dex" field needed.
//   The adapter passes `symbol` straight through untouched; which specific
//   instrument it is is entirely the caller's (main.cpp's) concern.
// - Depth caps at 20 levels/side (WsBook's fixed format) — shallower than
//   Bybit's up-to-200/export's up-to-100. The web layer's depth-level
//   selector already tracks whatever the live snapshot actually carries
//   (see DepthCurve.tsx's maxAvailableLevels), so this needs no adapter-
//   side workaround, just fewer dropdown options for a Hyperliquid source.
class HyperliquidAdapter : public IMarketDataSource {
public:
    static constexpr auto RECONNECT_BASE_DELAY   = std::chrono::seconds(1);
    static constexpr auto RECONNECT_MAX_DELAY    = std::chrono::seconds(30);
    static constexpr int  RECONNECT_BACKOFF_MULT = 2;

    HyperliquidAdapter(SpscRingBuffer<Tick, 1024>& queue,
                        std::atomic<bool>& stop_flag,
                        LatencyStore& latency,
                        std::atomic<uint64_t>& last_u,
                        std::string symbol);

    void run(Channel channel) override;

private:
    SpscRingBuffer<Tick, 1024>& queue_;
    std::atomic<bool>& stop_flag_;
    LatencyStore& latency_;
    std::atomic<uint64_t>& last_u_;
    std::string             symbol_;
    std::atomic<uint64_t>   reconnect_count_{0};
    Channel                 channel_{Channel::Depth};

    // Reusable scratch buffers — mirrors BybitAdapter's zero-allocation
    // hot-path convention. Sized for l2Book's fixed 20-level/side cap.
    std::vector<PriceLevel> scratch_bids_;
    std::vector<PriceLevel> scratch_asks_;

    void connect_and_read();
    void trigger_resync();
    void dispatch(simdjson::padded_string_view message);
    bool parse_depth(simdjson::dom::element data, Tick& tick);
    bool parse_trade(simdjson::dom::element data, Tick& tick);

    simdjson::dom::parser parser_;
};
