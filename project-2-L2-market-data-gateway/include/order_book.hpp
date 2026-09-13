#pragma once
#include "types.hpp"
#include <array>
#include <cstdint>

// PriceLadder replaces std::map — contiguous array eliminates per-node heap allocation and pointer-chasing cache misses.
// Indexed by price tick offset from a base price anchored at snapshot mid; out-of-range prices are rejected at the boundary.
// qty=0 represents an empty slot, matching Binance's own level-delete convention — no special-case erase needed.
// clear() compiles down to a single memset over contiguous memory vs. std::map::clear() which calls delete on every node individually.
struct PriceLadder {
    // With PRICE_SCALE=10000 and TICK_STEP=1000, each tick is 0.1 USDT, so 2 million ticks gives us ±200,000 USDT of price headroom from the snapshot mid — more than enough for BTCUSDT even in a flash crash.
    static constexpr int64_t MAX_LEVELS = 2'000'000; 

    // Level 1: one bit per price level, grouped into 64-level chunks
    static constexpr int64_t L1_CHUNKS = (MAX_LEVELS + 63) / 64; 
    
    // Level 2: one bit per L1 chunk, grouped into 64-chunk words
    static constexpr int64_t L2_WORDS  = (L1_CHUNKS + 63) / 64;

    std::array<int64_t, MAX_LEVELS> qtys{};
    std::array<uint64_t, L1_CHUNKS> L1{};
    std::array<uint64_t, L2_WORDS> L2{};

    // PRICE_SCALE=10000 means 1 tick = 0.0001 USDT, so TICK_STEP=1000 gives us 0.1 USDT tick size in the integer domain.
    static constexpr int64_t TICK_STEP = 1000; // 0.1 USDT per tick at PRICE_SCALE=10000

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

    void    init(int64_t mid_price_ticks); // cold path — called once on snapshot arrival to anchor the ladder
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