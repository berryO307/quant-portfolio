#pragma once
#include <atomic>
#include <cstdint>
#include <mutex>
#include <vector>
#include <algorithm>
#include <cmath>

// Simplified HDR-histogram-style latency tracker: fixed geometric bucket
// boundaries (~1% relative resolution per bucket) give O(log n) record() and
// approximate percentile queries in bounded, small memory — the same spirit
// as a real HdrHistogram (log-scaled buckets, no unbounded growth) without
// replicating its exact power-of-two bucket-index arithmetic.
//
// Intentionally pure data + query, no printing: record() is meant to be
// called only from the cold-path drain thread (see ColdPathExporter), and
// snapshot() is meant to be polled by whatever wants to observe it — a
// terminal view today, potentially a relay/web layer later — without this
// class knowing or caring who's asking.
//
// Thread-safety: record() (single writer expected) and snapshot() (any
// number of readers) are both mutex-guarded. This is not the hot path, so a
// mutex here is the simplest correct choice — no need for lock-free tricks.
class LiveHistogram {
public:
    struct Snapshot {
        uint64_t count   = 0;
        uint64_t max_ns  = 0;
        uint64_t p50_ns  = 0;
        uint64_t p99_ns  = 0;
        uint64_t p999_ns = 0;
    };

    LiveHistogram() {
        constexpr double   kRatio = 1.01;        // ~1% per-bucket resolution
        constexpr uint64_t kMaxNs = 1ull << 31;  // ~2.1s ceiling; larger values clamp into the top bucket

        uint64_t v = 1;
        boundaries_.push_back(v);
        while (v < kMaxNs) {
            uint64_t next = static_cast<uint64_t>(static_cast<double>(v) * kRatio);
            if (next <= v) next = v + 1;   // guard against rounding stalls at small v
            v = next;
            boundaries_.push_back(v);
        }
        counts_.assign(boundaries_.size(), 0);
    }

    // Called by the drain thread only, once per sample.
    void record(uint64_t value_ns) {
        auto it = std::lower_bound(boundaries_.begin(), boundaries_.end(), value_ns);
        size_t idx = (it == boundaries_.end())
                   ? boundaries_.size() - 1
                   : static_cast<size_t>(it - boundaries_.begin());

        std::lock_guard<std::mutex> lock(mu_);
        ++counts_[idx];
        ++count_;
        if (value_ns > max_ns_) max_ns_ = value_ns;
    }

    // Safe to call from any thread, at any time — this is the only surface
    // a consumer (terminal view, future relay/web layer, ...) needs.
    Snapshot snapshot() const {
        std::lock_guard<std::mutex> lock(mu_);
        Snapshot snap;
        snap.count  = count_;
        snap.max_ns = max_ns_;
        if (count_ == 0) return snap;

        uint64_t t50  = (count_ * 50)  / 100;
        uint64_t t99  = (count_ * 99)  / 100;
        uint64_t t999 = (count_ * 999) / 1000;

        uint64_t cum = 0;
        for (size_t i = 0; i < counts_.size(); ++i) {
            cum += counts_[i];
            if (snap.p50_ns == 0 && cum > t50)   snap.p50_ns  = boundaries_[i];
            if (snap.p99_ns == 0 && cum > t99)   snap.p99_ns  = boundaries_[i];
            if (snap.p999_ns == 0 && cum > t999) { snap.p999_ns = boundaries_[i]; break; }
        }
        return snap;
    }

private:
    std::vector<uint64_t> boundaries_;   // immutable after construction — safe to read without the lock
    std::vector<uint64_t> counts_;
    mutable std::mutex    mu_;
    uint64_t              count_  = 0;
    uint64_t              max_ns_ = 0;
};
