#pragma once
#include <atomic>
#include <cstddef>
#include <utility>

template<typename T, size_t N>
class SpscRingBuffer {
    static_assert((N != 0) && ((N & (N - 1)) == 0),
                  "Capacity must be a power of 2");

private:
    static constexpr size_t MASK = N - 1;

    alignas(64) std::atomic<size_t> head_{0};  // written only by producer
    alignas(64) std::atomic<size_t> tail_{0};  // written only by consumer
    // Each side's private, non-atomic cache of the OTHER side's index.
    //
    // Without these, every push did an acquire-load of tail_ and every pop an
    // acquire-load of head_ — a read of a cache line the other thread is
    // actively writing, i.e. a guaranteed coherence miss on EVERY operation
    // even when the ring is nowhere near full or empty. The cached copy is
    // only refreshed when it claims the ring is full (push) or empty (pop),
    // which is the only time the real value can change the answer: tail_ only
    // ever advances, so a stale cached_tail_ can under-report free space but
    // never over-report it, and symmetrically for cached_head_.
    //
    // This matters most exactly where this project's tail latency lives —
    // draining one WS frame's worth of trades. On a 30-trade burst the
    // consumer now learns "29 more are ready" once and pops all of them
    // without touching head_ again, instead of taking a coherence miss per
    // tick. They get their own cache lines for the same reason head_/tail_
    // do: a private counter sharing a line with an atomic the other thread
    // writes would reintroduce exactly the sharing this removes.
    alignas(64) size_t cached_tail_{0};        // producer-private view of tail_
    alignas(64) size_t cached_head_{0};        // consumer-private view of head_
    alignas(64) T buffer_[N];                  // own cache line(s), away from counters

    // Claims the next producer slot, or returns false when genuinely full.
    // Shared by both push overloads so the index/ordering protocol exists
    // once, not twice.
    bool acquire_slot(size_t& h) {
        h = head_.load(std::memory_order_relaxed); // ① producer owns head — no sync needed
        if (h - cached_tail_ >= N) {               // ② looks full per our cached view
            cached_tail_ = tail_.load(std::memory_order_acquire); // refresh: see consumer's latest pop
            if (h - cached_tail_ >= N) return false; // genuinely full — wraps safely for unsigned
        }
        return true;
    }

public:
    // Called by PRODUCER thread only
    bool push(const T& item) {
        size_t h;
        if (!acquire_slot(h)) return false;

        buffer_[h & MASK] = item;              // ③ write BEFORE publishing index

        head_.store(h + 1, std::memory_order_release); // ④ release: consumer now sees the written item
        return true;
    }

    // Rvalue overload. Call sites already wrote push(std::move(tick)) and had
    // been getting a COPY for it: the only overload was push(const T&), which
    // an rvalue binds to happily and silently. For Tick that means copying a
    // variant whose DepthUpdate alternative owns two std::vectors, instead of
    // stealing their buffers.
    bool push(T&& item) {
        size_t h;
        if (!acquire_slot(h)) return false;

        buffer_[h & MASK] = std::move(item);

        head_.store(h + 1, std::memory_order_release);
        return true;
    }

    // Called by CONSUMER thread only
    bool pop(T& item) {
        const size_t t = tail_.load(std::memory_order_relaxed); // ① consumer owns tail — no sync needed
        if (t == cached_head_) {                                // ② looks empty per our cached view
            cached_head_ = head_.load(std::memory_order_acquire); // refresh: see producer's latest push
            if (t == cached_head_) return false;                 // genuinely empty
        }

        item = buffer_[t & MASK];             // ③ read BEFORE publishing index

        tail_.store(t + 1, std::memory_order_release); // ④ release: producer now sees the freed slot
        return true;
    }

    // Approximate — safe for logging/monitoring only
    size_t size() const {
        return head_.load(std::memory_order_relaxed)
             - tail_.load(std::memory_order_relaxed);
    }

    bool empty() const { return size() == 0; }
    bool full()  const { return size() >= N; }
};