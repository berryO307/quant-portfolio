#pragma once
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <vector>
#include <algorithm>
#include <chrono>
#include <thread>
#include <fstream>
#include <iostream>

// rdtscp preferred over rdtsc: the 'p' variant issues a serializing instruction
// (RDTSCP implicitly executes LFENCE) so the CPU cannot reorder instructions
// across the measurement point. Plain rdtsc can be speculated past, giving
// falsely low deltas on out-of-order CPUs.
inline uint64_t rdtscp() {
    uint32_t aux;   // receives the IA32_TSC_AUX MSR (core/socket ID) — we discard it
    uint64_t tsc;
    __asm__ volatile(
        "rdtscp\n\t"
        "shl $32, %%rdx\n\t"    // shift high 32 bits into position
        "or  %%rdx, %%rax"      // combine into one 64-bit value
        : "=a"(tsc), "=c"(aux)
        :
        : "rdx"
    );
    return tsc;
}

 //Hardcoding CPU_GHZ is brittle across different environments. Modern CPUs use an 
 //"Invariant TSC" that ticks at a constant rate regardless of Turbo Boost/SpeedStep.
 //Instead of hardcoding, we run this calibration once at startup. It sleeps for a 
 //known duration (100ms) and counts the delta in TSC ticks. 
 //Since (Cycles / Nanoseconds) == GHz, this dynamically perfectly calculates the 
 //host machine's tick rate without manual OS queries.

inline double calibrate_tsc_ghz() {
    auto start_time = std::chrono::steady_clock::now();
    uint64_t start_tsc = rdtscp(); // Grab initial tick
    
    // Sleep for 100ms to get a stable, large sample window
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    
    auto end_time = std::chrono::steady_clock::now();
    uint64_t end_tsc = rdtscp(); // Grab final tick
    
    // Elapsed time in nanoseconds
    std::chrono::duration<double, std::nano> elapsed_ns = end_time - start_time;
    
    // Cycles per nanosecond is mathematically identical to GHz.
    double actual_ghz = static_cast<double>(end_tsc - start_tsc) / elapsed_ns.count();
    
    return actual_ghz;
}

// Update your tsc_to_ns to accept this dynamically calculated value
inline double tsc_to_ns(uint64_t delta, double cpu_ghz) {
    return static_cast<double>(delta) / cpu_ghz;
}

// Pre-allocated storage for latency samples — zero heap allocation on hot path.
// reserve() at startup, record() during run, dump on shutdown.
//
// WHY CAPPED RATHER THAN SIZED-TO-RUN-LENGTH: a plain emplace_back() grows a
// std::vector by doubling, and every doubling is a malloc + memcpy-everything
// + free executed ON the hot-path thread. Reserving enough for a whole
// session only moves that cliff further out; it doesn't remove it, and sizing
// for a long session at a high tick rate costs hundreds of MB up front (10M
// samples x 8 bytes x 4 vectors = 320MB). Capping instead means the hot path
// NEVER allocates, for any session length, at a fixed and modest memory cost.
//
// Dropping samples past the cap is acceptable here specifically because this
// CSV is redundant: ColdPathExporter already writes every sample to NDJSON
// with the full per-stage timestamp set, which is strictly more information
// than these four cycle deltas. dropped() makes the truncation visible rather
// than silent.
//
// 2M x 8 bytes x 4 vectors = 64MB, which at this pipeline's measured live
// rate (~13 ticks/s) is over 40 hours, and at a much busier 500 ticks/s is
// still ~1.1 hours.
struct LatencyStore {
    static constexpr size_t kDefaultCapacity = 2'000'000;

    std::vector<uint64_t> parse_cycles;   // point1 → point2 (parse latency)
    std::vector<uint64_t> queue_cycles;   // point2 → point3 (queue transit latency)
    std::vector<uint64_t> book_cycles;    // point2 → point4 (parse done -> book-update done)
    std::vector<uint64_t> publish_cycles; // point4 → point5 (book-update done -> mmap publish done)

    void reserve(size_t n = kDefaultCapacity) {
        parse_cycles.reserve(n);
        queue_cycles.reserve(n);
        book_cycles.reserve(n);
        publish_cycles.reserve(n);
    }

    // The ONLY way the hot path should append. Never grows the vector: at
    // capacity the sample is counted and discarded, so this cannot malloc,
    // memcpy or free on a latency-critical thread. Callers previously used
    // emplace_back() directly, which could do all three.
    void record(std::vector<uint64_t>& v, uint64_t cycles) {
        if (v.size() < v.capacity()) {
            v.push_back(cycles);
        } else {
            dropped_.fetch_add(1, std::memory_order_relaxed);
        }
    }

    uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

private:
    // Written from both hot-path threads once their vectors fill, so atomic
    // even though it's only read at shutdown.
    std::atomic<uint64_t> dropped_{0};

public:

    // Cold-path I/O: uses std::ofstream for simplicity 
    // since this runs after trading stops; hot path uses mmap for low-latency writes.
    void dump(const std::string& filepath, double calibrated_ghz) const {
        // Truncation is visible, not silent — see record()'s comment for why
        // the cap exists and why dropping here is acceptable (the NDJSON
        // export carries every sample with more detail than this CSV).
        const uint64_t d = dropped();
        if (d > 0) {
            std::cerr << "[LatencyStore] " << d << " samples not recorded: the "
                      << parse_cycles.capacity() << "-sample per-stage capacity filled. "
                         "The CSV below covers the start of the session only; the "
                         "NDJSON export in data/export/ has the full set.\n";
        }

        std::ofstream csv(filepath);
        if (!csv.is_open()) {
            std::cerr << "[LatencyStore] Warning: Could not open " << filepath << " for writing.\n";
            return;
        }

    // Per-stage CSV: recv->parse (simdjson hot path), parse->dequeue (SPSC ring buffer),
    // dequeue->book-update, and book-update->publish (mmap write).
    // parse_cycles:   rdtscp delta from frame arrival to queue push (t1->t2). For a
    //                 multi-tick frame this is cumulative through this tick's
    //                 position in the frame (every tick in the frame shares
    //                 t1) — a deliberate simplification, not a bug; see
    //                 Tick's own comment in types.hpp.
    // queue_cycles:   rdtscp delta from queue push to consumer pop (t2->t3).
    // book_cycles:    rdtscp delta from consumer pop to book-update done (t3->t4) —
    //                 NOT t2->t4, which would span the queue wait too.
    // publish_cycles: rdtscp delta from book-update done to mmap publish done (t4->t5).
    // Reported in nanoseconds using the dynamically calibrated TSC frequency.
    csv << "queue_transit_ns,parse_ns,book_update_ns,publish_ns\n";

    // Zip all four vectors — use the shortest to avoid out-of-bounds if counts diverge.
    // All four are appended by the consumer thread, for the same tick, under the same
    // pre-seed filter (see consumer_loop), so they are aligned by construction. That
    // was not always true: parse_cycles used to be appended by the PRODUCER thread,
    // which parses ahead of the consumer, keeps recording for ticks dropped on queue
    // overflow, and recorded the pre-seed ticks the consumer skips — leaving row i
    // pairing one tick's parse with a different tick's queue wait (observed: 1026
    // parse entries against 993 for every other stage).
    size_t n = std::min({queue_cycles.size(), parse_cycles.size(),
                          book_cycles.size(), publish_cycles.size()});
    if (parse_cycles.empty()) {
        std::cerr << "[LatencyStore] WARNING: parse_cycles is empty — "
                  << "check that dispatch() calls latency_.record(latency_.parse_cycles, ...)\n";
    }

    for (size_t i = 0; i < n; ++i) {
        if (i < queue_cycles.size())
            csv << tsc_to_ns(queue_cycles[i], calibrated_ghz);
        csv << ",";
        if (i < parse_cycles.size())
            csv << tsc_to_ns(parse_cycles[i], calibrated_ghz);
        csv << ",";
        if (i < book_cycles.size())
            csv << tsc_to_ns(book_cycles[i], calibrated_ghz);
        csv << ",";
        if (i < publish_cycles.size())
            csv << tsc_to_ns(publish_cycles[i], calibrated_ghz);
        csv << "\n";
    }

    std::cout << "[main] Latency metrics dumped: " << n
              << " records (queue=" << queue_cycles.size()
              << " parse=" << parse_cycles.size()
              << " book=" << book_cycles.size()
              << " publish=" << publish_cycles.size()
              << ") to " << filepath << "\n";
    }
};