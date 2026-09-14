#pragma once
#include "types.hpp"
#include <array>
#include <cstdint>

// PriceLadder replaces std::map — contiguous array eliminates per-node heap allocation and pointer-chasing cache misses.
// Indexed by price tick offset from a base price anchored at snapshot mid; out-of-range prices are rejected at the boundary.
// qty=0 represents an empty slot, matching Binance's own level-delete convention — no special-case erase needed.
// clear() compiles down to a single memset over contiguous memory vs. std::map::clear() which calls delete on every node individually.
struct PriceLadder {
    // 2 million slots at the default 0.1 USDT tick_step gives ±200,000 USDT
    // of price headroom from the snapshot mid — sized for BTCUSDT, the
    // project's original and only instrument. tick_step itself is now a
    // per-instance runtime value (see below) rather than a compile-time
    // constant, since a fixed 0.1 USDT step silently corrupts depth for any
    // instrument with a finer real tick size: two genuinely distinct price
    // levels closer together than 0.1 USDT (e.g. WTI crude trades in
    // ~$0.001-0.01 increments) integer-divide to the SAME ladder index and
    // overwrite each other — no crash, no error, just fewer real levels
    // than were actually sent. Found via a live Hyperliquid xyz:CL capture:
    // a 20-level snapshot collapsed to 1-2 surviving levels per side.
    static constexpr int64_t MAX_LEVELS = 2'000'000;

    // Level 1: one bit per price level, grouped into 64-level chunks
    static constexpr int64_t L1_CHUNKS = (MAX_LEVELS + 63) / 64;

    // Level 2: one bit per L1 chunk, grouped into 64-chunk words
    static constexpr int64_t L2_WORDS  = (L1_CHUNKS + 63) / 64;

    std::array<int64_t, MAX_LEVELS> qtys{};
    std::array<uint64_t, L1_CHUNKS> L1{};
    std::array<uint64_t, L2_WORDS> L2{};

    // Ladder index granularity, in raw scaled-price units (PRICE_SCALE=10000
    // => 1 unit = 0.0001 USDT). Set once per snapshot by init(), inferred
    // from that snapshot's own price data (see OrderBook::seed) — not a
    // fixed constant, so the ladder self-adjusts to whatever instrument is
    // actually being captured. Defaults to 1000 (0.1 USDT, BTCUSDT's real
    // tick) so a PriceLadder that's never had init() called behaves exactly
    // as before this change.
    int64_t tick_step = 1000;

    // Best price tracking: updated incrementally on each level change via bitmap scans; avoids scanning the full ladder on every tick
    int64_t get_best_ask() const;
    int64_t get_best_bid() const;

    // Collect up to max_n occupied levels, walking outward from the best price.
    // from_high=true walks toward lower prices (bids); false walks toward higher
    // prices (asks). Read-only, does not touch the incremental best-price cache.
    // Intended for periodic (~1/s) export snapshots, not the per-tick hot path —
    // cost is O(max_n) plus a bounded bitmap walk, not O(MAX_LEVELS).
    int top_n(PriceLevel* out, int max_n, bool from_high) const;

    int64_t base_price  = 0;  // price tick that maps to index 0; set once per snapshot, never moves during a session
    bool    initialized = false;

    // cold path — called once on snapshot arrival to anchor the ladder.
    // tick_step_in: this ladder's index granularity for the session until
    // the next init() call (see OrderBook::seed).
    void    init(int64_t mid_price_ticks, int64_t tick_step_in);
    bool    set(int64_t price_ticks, int64_t qty_ticks); // O(1) direct array write — no allocation, no tree rebalance
    int64_t get(int64_t price_ticks) const;              // O(1) direct array read
    void    clear();                                      // single memset — safe to call on reconnect without latency spike
};

// L2 order book.
//   bids_: flat ladder, best bid = highest occupied slot
//   asks_: flat ladder, best ask = lowest occupied slot
// Seeded from a REST snapshot, then updated via WS depthUpdate events.
// Sequence gaps are logged but non-fatal.
class OrderBook {
public:
    // Seed from REST snapshot. Must be called before apply_depth.
    void seed(const OrderBookSnapshot& snap);

    // Convenience wrapper for rvalue snapshots — delegates to seed()
    void resync(OrderBookSnapshot&& snap) { seed(snap); }

    // Apply a WS depthUpdate diff.
    // Returns false if book is not seeded or event is stale.
    bool apply_depth(const DepthUpdate& upd);

    // Top-of-book accessors. Return 0 if book is empty.
    int64_t best_bid() const { return best_bid_; }
    int64_t best_ask() const { return best_ask_; }

    int64_t spread() const { return best_ask() - best_bid(); }

    // Mid-price in integer domain.
    // PRICE_SCALE=10000 ensures 1-tick spreads divide without truncation.
    int64_t mid() const {
        if (best_bid_ == 0 || best_ask_ == 0) return 0;
        return (best_bid_ + best_ask_) / 2;
    }

    int64_t last_update_id() const { return last_update_id_; }
    bool    is_seeded()      const { return seeded_; }

    // Periodic export snapshot helpers — see PriceLadder::top_n. Cold path only.
    int top_bids(PriceLevel* out, int max_n) const { return bids_.top_n(out, max_n, true); }
    int top_asks(PriceLevel* out, int max_n) const { return asks_.top_n(out, max_n, false); }

private:
    void apply_levels(const std::vector<PriceLevel>& levels, PriceLadder& ladder);
    void update_best_bid(int64_t changed_price, int64_t new_qty);
    void update_best_ask(int64_t changed_price, int64_t new_qty);

    PriceLadder bids_;
    PriceLadder asks_;

    // Cached best prices — updated incrementally on each depth event.
    // Avoids scanning the full ladder on every tick.
    int64_t best_bid_       = 0;
    int64_t best_ask_       = 0;
    int64_t last_update_id_ = 0;
    int64_t last_u_         = 0;
    bool    seeded_         = false;
};