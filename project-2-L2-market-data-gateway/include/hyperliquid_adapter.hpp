#pragma once
#include "types.hpp"
#include "spsc_ring_buffer.hpp"
#include "rdtsc.hpp"
#include "market_data_source.hpp"
#include "coarse_book_state.hpp"
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
                        std::atomic<uint64_t>& queue_overflow_dropped,
                        std::string symbol,
                        // Only meaningful for Channel::CoarseDepth (see that
                        // enumerator's comment) — null/0 for the real
                        // Depth/Trades channels, which never touch either.
                        CoarseBookState* coarse_state = nullptr,
                        int coarse_nsigfigs = 0);

    void run(Channel channel) override;

private:
    SpscRingBuffer<Tick, 1024>& queue_;
    std::atomic<bool>& stop_flag_;
    LatencyStore& latency_;
    std::atomic<uint64_t>& last_u_;
    // Distinct from OrderBook/main.cpp's depth_dropped (a book-sequencing
    // counter — stale/out-of-order events discarded during resync).
    // This one counts a DIFFERENT failure mode entirely: queue_.push()
    // returning false because SpscRingBuffer<Tick,1024> is full, which
    // silently dropped the tick with zero visibility before this counter
    // existed. Shared by both adapter instances (depth-channel and
    // trades-channel each get their own HyperliquidAdapter — see
    // main.cpp — pushing into their own ring buffer), so a nonzero value
    // here means SOME ring overflowed, not specifically which one; that's
    // enough to know the 1024 capacity needs revisiting, without needing
    // two separate counters end-to-end for a drop path that (as of this
    // fix) has not yet been observed to fire at all.
    std::atomic<uint64_t>& queue_overflow_dropped_;
    std::string             symbol_;
    std::atomic<uint64_t>   reconnect_count_{0};
    Channel                 channel_{Channel::Depth};
    CoarseBookState*        coarse_state_{nullptr};
    int                     coarse_nsigfigs_{0};

    // Reusable scratch buffers — mirrors BybitAdapter's zero-allocation
    // hot-path convention. Sized for l2Book's fixed 20-level/side cap.
    std::vector<PriceLevel> scratch_bids_;
    std::vector<PriceLevel> scratch_asks_;

    void connect_and_read();
    void trigger_resync();
    void dispatch(simdjson::padded_string_view message);
    // On-Demand values are single-pass and forward-only: each takes its field
    // reads in wire order (see the field-order notes in the .cpp). They are
    // passed by value because an ondemand::value is a cursor, not a handle to
    // parsed data — it can only be consumed once.
    bool parse_depth(simdjson::ondemand::value data, Tick& tick);
    bool parse_trade(simdjson::ondemand::value data, Tick& tick);

    // On-Demand, not DOM. DOM parses the whole document eagerly, so for a
    // trades frame carrying N trades the entire message was parsed before
    // element 0 could be touched — and that cost landed on the first tick of
    // the frame, which every later sibling then inherits as in-frame wait.
    //
    // Measured on 102-element frames (~10.5KB), 1500 distinct messages each
    // parsed once, time from parse start to first element available:
    //   DOM                                   p50 = 10,250 ns
    //   On-Demand + count_elements + iterate  p50 =  6,100 ns
    // and for the l2Book path the two were a dead heat (1,630 vs 1,640 ns),
    // because that message is small and every field is read — On-Demand only
    // wins where there is something left unparsed.
    //
    // count_elements() costs ~2,660 ns of that and is kept deliberately: it is
    // what supplies batch_size, and inferring batch_size anywhere else would
    // change the field's meaning across the relay, the web app and the
    // dashboard for a saving that does not justify it.
    simdjson::ondemand::parser parser_;
};
