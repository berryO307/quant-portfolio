#pragma once
#include "types.hpp"
#include <atomic>
#include <cstdint>
#include <mutex>
#include <vector>

// Hand-off point between the coarse-book WS listener (see HyperliquidAdapter's
// Channel::CoarseDepth) and the consumer thread, which is the sole owner of
// exporter.push() — see export_pipeline.hpp's ExportRingBuffer, a strict
// SPSC ring. The coarse listener runs on its OWN thread (a second, wider-
// rounded l2Book subscription, kept entirely separate from the real
// depth/trades pipeline — see Channel::CoarseDepth's own comment for why),
// so it cannot safely call exporter.push() itself without turning that ring
// into an (unsupported) multi-producer one. Instead it writes here, and the
// consumer thread picks the latest value up on its own next iteration and
// pushes it through the export path it already owns.
//
// Deliberately "latest value wins", not a queue: this is a rounded, display-
// only view of the book (see the class it enables, CoarseBookListener/
// HyperliquidAdapter's coarse path) — nothing downstream needs every
// intermediate coarse snapshot Hyperliquid ever sent, only the most recent
// one whenever the consumer thread next checks. A plain mutex is more than
// fast enough for how rarely this updates (bounded by Hyperliquid's own
// l2Book push rate for that coin, not by anything latency-sensitive) and
// this is never touched from the hot path itself.
class CoarseBookState {
public:
    void update(std::vector<PriceLevel> bids, std::vector<PriceLevel> asks, uint64_t tsc) {
        std::lock_guard<std::mutex> lk(mu_);
        bids_ = std::move(bids);
        asks_ = std::move(asks);
        tsc_  = tsc;
        dirty_.store(true, std::memory_order_release);
    }

    // Returns true and fills the three out-params if a new snapshot has
    // arrived since the last successful take(); leaves them untouched and
    // returns false otherwise. The dirty check is lock-free so the consumer
    // thread's hot iteration (called on every tick, not just when the
    // coarse book actually changed) pays no mutex cost in the common case.
    bool take(std::vector<PriceLevel>& bids_out, std::vector<PriceLevel>& asks_out, uint64_t& tsc_out) {
        if (!dirty_.load(std::memory_order_acquire)) return false;
        std::lock_guard<std::mutex> lk(mu_);
        if (!dirty_.load(std::memory_order_relaxed)) return false; // lost the race to another take()
        bids_out = bids_;
        asks_out = asks_;
        tsc_out  = tsc_;
        dirty_.store(false, std::memory_order_release);
        return true;
    }

private:
    std::mutex mu_;
    std::vector<PriceLevel> bids_;
    std::vector<PriceLevel> asks_;
    uint64_t tsc_ = 0;
    std::atomic<bool> dirty_{false};
};

// A single coarse tier's own hand-off slot plus the nSigFigs that produced
// it. One tier alone (the first version of this feature) was not enough:
// bucketing a snapshot whose own native level spacing is already wider than
// the requested display bucket is a no-op, so a $5/$10/$100 bucket selection
// rendered identically to the $1000 one once there was only a single
// nSigFigs=2 source. COARSE_TIERS below is the fixed, instrument-agnostic
// set this project settled on; see market_data_source.hpp's
// Channel::CoarseDepth comment for why the set is fixed rather than
// per-instrument, and lib/orderBook.ts's pickBestSnapshot on the web side
// for how a bucket size picks which of these (or the primary, unrounded
// snapshot) it actually renders from.
struct CoarseTier {
    int nsigfigs;
    CoarseBookState state;
};

// Hyperliquid's l2Book nSigFigs accepts roughly 2-5 (5, or omitting the
// field entirely, is the venue's own default/finest rounding -- what the
// PRIMARY depth subscription already uses, so it is deliberately not
// repeated here as a fourth tier). Finest-to-coarsest order matters: see
// pickBestSnapshot's "prefer the finest tier that still covers enough
// range" rule on the web side, which relies on this ordering only for
// readability, not correctness (it re-sorts by nsigfigs itself).
inline constexpr int COARSE_TIERS[] = {4, 3, 2};
inline constexpr size_t COARSE_TIER_COUNT = sizeof(COARSE_TIERS) / sizeof(COARSE_TIERS[0]);
