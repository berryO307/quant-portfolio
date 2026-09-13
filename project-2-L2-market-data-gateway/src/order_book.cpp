#include "order_book.hpp"
#include "AsyncLogger.hpp"
#include <iostream>
#include <cstring> 
#include <cstdint>
#include <bit>

// Anchors the ladder to a mid price so both sides share the same index space — called once on snapshot, never on the hot path
void PriceLadder::init(int64_t mid_price_ticks) {
    clear();
    //Force the mid price to perfectly align with TICK_STEP
    int64_t aligned_mid = (mid_price_ticks / TICK_STEP) * TICK_STEP;
    // Center the ladder on the snapshot mid price; ensures we can represent a symmetric range above and below the mid, which is ideal for book updates that typically cluster around the top of book.
    base_price = aligned_mid - ((MAX_LEVELS / 2) * TICK_STEP);
}

// Direct index write; O(1), no allocation, no tree rebalance; returns false if price falls outside the ladder window
// Uses explicit error return instead of exceptions—throwing would trigger 
// stack unwinding (destructors + frame walk), causing unpredictable latency in this hot path.
bool PriceLadder::set(int64_t price_ticks, int64_t qty) {
    int64_t idx = (price_ticks - base_price) / TICK_STEP; // Convert price to ladder index
    if (static_cast<uint64_t>(idx) >= static_cast<uint64_t>(MAX_LEVELS)){
        // Log out-of-range errors for visibility, but don't throw exceptions from this hot path
        std::cerr << "[PriceLadder] Error: price " << price_ticks 
                  << " is out of range (base=" << base_price 
                  << ", idx=" << idx 
                  << ", MAX_LEVELS=" << MAX_LEVELS << ")\n";
        return false;
    }

    qtys[idx] = qty;

    // --- Bitmap maintenance ---
    int64_t  l1_chunk  = idx / 64;          // which L1 word
    int64_t  l1_bit    = idx % 64;          // which bit inside that L1 word
    int64_t  l2_word   = l1_chunk / 64;     // which L2 word
    int64_t  l2_bit    = l1_chunk % 64;     // which bit inside that L2 word

    if (qty > 0) {
        L1[l1_chunk] |=  (uint64_t(1) << l1_bit);   // mark level occupied
        L2[l2_word]  |=  (uint64_t(1) << l2_bit);   // mark chunk non-empty
    } else {
        L1[l1_chunk] &= ~(uint64_t(1) << l1_bit);   // clear level
        // Only clear L2 bit if the entire L1 chunk is now empty
        if (L1[l1_chunk] == 0)
            L2[l2_word] &= ~(uint64_t(1) << l2_bit);
    }

    return true;
}

// Direct index read; O(1); returns 0 for out-of-range prices, consistent with empty-slot semantics
int64_t PriceLadder::get(int64_t price_ticks) const {
    int64_t idx = (price_ticks - base_price) / TICK_STEP; // Convert price to ladder index
    // Unsigned cast wraps negatives to huge positives, collapsing two comparisons into one branch
    if (static_cast<uint64_t>(idx) >= MAX_LEVELS) return 0;
    return qtys[idx];
}

// Single contiguous memset; replaces std::map::clear() which called delete on every node individually (O(N) frees, cache-hostile)
void PriceLadder::clear() {
    std::memset(qtys.data(), 0, sizeof(qtys));
    std::memset(L1.data(), 0, sizeof(L1));
    std::memset(L2.data(), 0, sizeof(L2));
    base_price = 0;
}

// Returns the lowest price in the ladder (Best Ask)
int64_t PriceLadder::get_best_ask() const {
    // Scan L2 array forward to find the first non-empty L1 chunk
    for (size_t i = 0; i < L2.size(); ++i) {
        if (L2[i] != 0) {
            // Find the lowest set bit in this L2 word (trailing zeros)
            int l2_bit = __builtin_ctzll(L2[i]);
            int l1_chunk = (i * 64) + l2_bit;
            
            // Find the lowest set bit in the corresponding L1 word
            int l1_bit = __builtin_ctzll(L1[l1_chunk]);
            
            int64_t idx = (l1_chunk * 64) + l1_bit;
            return base_price + idx * TICK_STEP; // Convert ladder index back to price
        }
    }
    return 0; // Book is empty
}

// Returns the highest price in the ladder (Best Bid)
int64_t PriceLadder::get_best_bid() const {
    // Scan L2 array backward to find the highest non-empty L1 chunk
    for (int i = L2.size() - 1; i >= 0; --i) {
        if (L2[i] != 0) {
            // Find the HIGHEST set bit in this L2 word (leading zeros)
            int l2_bit = 63 - __builtin_clzll(L2[i]);
            int l1_chunk = (i * 64) + l2_bit;
            
            // Find the HIGHEST set bit in the corresponding L1 word
            int l1_bit = 63 - __builtin_clzll(L1[l1_chunk]);
            
            int64_t idx = (l1_chunk * 64) + l1_bit;
            return base_price + idx * TICK_STEP; // Convert ladder index back to price
        }
    }
    return 0; // Book is empty
}

// Cold path (periodic export snapshots only, ~1/s): walks the two-level bitmap
// from the best price outward, collecting up to max_n occupied levels. Same
// bit-tricks as get_best_bid/get_best_ask, but clears each found bit from a
// local copy of the word so the scan can continue past the first hit instead
// of returning immediately. Does not mutate the ladder or the best-price cache.
int PriceLadder::top_n(PriceLevel* out, int max_n, bool from_high) const {
    int count = 0;

    if (from_high) {
        for (int64_t w = static_cast<int64_t>(L2.size()) - 1; w >= 0 && count < max_n; --w) {
            uint64_t l2_word = L2[w];
            while (l2_word != 0 && count < max_n) {
                int l2_bit    = 63 - __builtin_clzll(l2_word);
                int64_t l1_chunk = (w * 64) + l2_bit;
                uint64_t l1_word = L1[l1_chunk];

                while (l1_word != 0 && count < max_n) {
                    int bit_pos = 63 - __builtin_clzll(l1_word);
                    int64_t idx = (l1_chunk * 64) + bit_pos;
                    out[count++] = PriceLevel{ base_price + idx * TICK_STEP, qtys[idx] };
                    l1_word &= ~(uint64_t(1) << bit_pos);
                }
                l2_word &= ~(uint64_t(1) << l2_bit);
            }
        }
    } else {
        for (int64_t w = 0; w < static_cast<int64_t>(L2.size()) && count < max_n; ++w) {
            uint64_t l2_word = L2[w];
            while (l2_word != 0 && count < max_n) {
                int l2_bit    = __builtin_ctzll(l2_word);
                int64_t l1_chunk = (w * 64) + l2_bit;
                uint64_t l1_word = L1[l1_chunk];

                while (l1_word != 0 && count < max_n) {
                    int bit_pos = __builtin_ctzll(l1_word);
                    int64_t idx = (l1_chunk * 64) + bit_pos;
                    out[count++] = PriceLevel{ base_price + idx * TICK_STEP, qtys[idx] };
                    l1_word &= ~(uint64_t(1) << bit_pos);
                }
                l2_word &= ~(uint64_t(1) << l2_bit);
            }
        }
    }

    return count;
}

// OrderBook
// Cold path; full state reset before applying a new snapshot; clear() here is a memset, not N heap frees
void OrderBook::seed(const OrderBookSnapshot& snap) {
    bids_.clear();
    asks_.clear();
    best_bid_ = 0;
    best_ask_ = 0;

    if (snap.bids.empty() || snap.asks.empty()) return;

    // Anchor both ladders to snapshot mid; ensures bids and asks share a consistent index space
    bids_.init(snap.bids.back().price);  // bids: lowest price = base
    asks_.init(snap.asks.front().price); // asks: lowest (best) price = base

    // qty > 0 guard matches Binance snapshot semantics; zero-qty levels in snapshots are malformed, not deletes
    for (const auto& l : snap.bids) if (l.qty > 0) bids_.set(l.price, l.qty);
    for (const auto& l : snap.asks) if (l.qty > 0) asks_.set(l.price, l.qty);

    // Seed best price cache from snapshot top; avoids a full ladder scan on first best_bid()/best_ask() call
    best_bid_       = snap.bids[0].price;
    best_ask_       = snap.asks[0].price;
    last_update_id_ = snap.last_update_id;
    last_u_         = 0;
    seeded_         = true;

    std::cerr << "[book] seeded at lastUpdateId=" << last_update_id_
              << "  best_bid=" << best_bid_
              << "  best_ask=" << best_ask_ << "\n";
}

// Hot path; drops stale events, logs sequence gaps, delegates level application to apply_levels
bool OrderBook::apply_depth(const DepthUpdate& upd) {
    if (!seeded_) return false;

    // Bybit: simple monotonic u check
    // upd.pu == 0 means this is a snapshot (rare after initial seed)
    if (upd.pu == 0) {
        // Snapshot mid-stream — full reseed
        OrderBookSnapshot snap;
        snap.last_update_id = upd.u;
        snap.bids = upd.bids;
        snap.asks = upd.asks;
        seed(snap);
        return true;
    }

    // Delta: u must be greater than last seen
    if (static_cast<uint64_t>(upd.u) <= static_cast<uint64_t>(last_u_)) {
        return false;   // stale or duplicate
    }

    apply_levels(upd.bids, bids_);
    apply_levels(upd.asks, asks_);

    last_update_id_ = upd.u;
    last_u_ = upd.u;

    // Sanity check: book must never cross. Best bid >= best ask is impossible
    // in a healthy market — it indicates a transient inconsistency from out-of-order
    // updates or a parsing bug. Force a resync rather than write corrupt data to mmap.
    if (best_bid_ != 0 && best_ask_ != 0 && best_bid_ >= best_ask_) {
        std::cerr << "[book] CROSSED bid=" << best_bid_
                  << " ask=" << best_ask_ << " — forcing resync\n";
        return false;
    }

    return true;
}

// Single overload replaces the dual std::map overloads whose header/cpp signatures were mismatched (int64_t vs double)
// qty=0 is handled as a natural slot clear — no branch needed to decide between insert and erase
void OrderBook::apply_levels(const std::vector<PriceLevel>& levels, PriceLadder& ladder) {
    // Custom ladder handles qty=0 natively!
    for (const auto& l : levels) {
        ladder.set(l.price, l.qty);
    }

    // Update the best bid/ask AFTER all deltas are processed using the bitmap scanners.
    if (&ladder == &bids_) {
        best_bid_ = bids_.get_best_bid(); 
    } else {
        best_ask_ = asks_.get_best_ask(); 
    }
}

// Incremental best bid maintenance; O(1) in the common case (new level above best or non-best level touched)
// Downward scan only triggers when the current best level is deleted; rare in a live book
void OrderBook::update_best_bid(int64_t changed_price, int64_t new_qty) {
    if (new_qty > 0 && changed_price > best_bid_) {
        best_bid_ = changed_price;
        return;
    }

    if (new_qty == 0 && changed_price == best_bid_) {
        int64_t start_idx = changed_price - bids_.base_price;

        // --- O(1) two-level bitboard scan (downward = toward lower prices) ---
        int64_t start_l1  = start_idx / 64;
        int64_t start_l2  = start_l1  / 64;

        for (int64_t w = start_l2; w >= 0; --w) {
            uint64_t l2_word = bids_.L2[w];

            // On the first L2 word, mask off bits above our starting chunk
            if (w == start_l2) {
                int64_t l2_bit = start_l1 % 64;
                l2_word &= (uint64_t(1) << (l2_bit + 1)) - 1;
            }

            if (l2_word == 0) continue;  // all 4096 levels in this block empty

            // Highest set bit in L2 → tells us which L1 chunk to look in
            int64_t l1_chunk = (w * 64) + (63 - __builtin_clzll(l2_word));

            uint64_t l1_word = bids_.L1[l1_chunk];

            // On the starting L1 chunk, mask off bits above start_idx
            if (l1_chunk == start_l1) {
                int64_t l1_bit = start_idx % 64;
                l1_word &= (uint64_t(1) << (l1_bit + 1)) - 1;
            }

            if (l1_word == 0) continue;  // shouldn't happen if L2 is correct, but be safe

            int64_t bit_pos = 63 - __builtin_clzll(l1_word);
            best_bid_ = bids_.base_price + (l1_chunk * 64) + bit_pos;
            return;
        }

        best_bid_ = 0;  // bid side is empty
    }
}

// Incremental best ask maintenance; symmetric to update_best_bid; upward scan only on best-level delete
void OrderBook::update_best_ask(int64_t changed_price, int64_t new_qty) {
    if (new_qty > 0 && changed_price < best_ask_) {
        best_ask_ = changed_price;
        return;
    }

    if (new_qty == 0 && changed_price == best_ask_) {
        int64_t start_idx = changed_price - asks_.base_price;

        // --- O(1) two-level bitboard scan (upward = toward higher prices) ---
        int64_t start_l1 = start_idx / 64;
        int64_t start_l2 = start_l1  / 64;

        for (int64_t w = start_l2; w < PriceLadder::L2_WORDS; ++w) {
            uint64_t l2_word = asks_.L2[w];

            // On the first L2 word, mask off bits below our starting chunk
            if (w == start_l2) {
                int64_t l2_bit = start_l1 % 64;
                l2_word &= ~((uint64_t(1) << l2_bit) - 1);
            }

            if (l2_word == 0) continue;  // all 4096 levels in this block empty

            // Lowest set bit in L2 → tells us which L1 chunk to look in
            int64_t l1_chunk = (w * 64) + __builtin_ctzll(l2_word);

            if (l1_chunk >= PriceLadder::L1_CHUNKS) break;  // bounds safety

            uint64_t l1_word = asks_.L1[l1_chunk];

            // On the starting L1 chunk, mask off bits below start_idx
            if (l1_chunk == start_l1) {
                int64_t l1_bit = start_idx % 64;
                l1_word &= ~((uint64_t(1) << l1_bit) - 1);
            }

            if (l1_word == 0) continue;

            int64_t bit_pos = __builtin_ctzll(l1_word);
            best_ask_ = asks_.base_price + (l1_chunk * 64) + bit_pos;
            return;
        }

        best_ask_ = 0;  // ask side is empty
    }
}
