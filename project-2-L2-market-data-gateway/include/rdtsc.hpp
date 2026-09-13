#pragma once
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
// reserve() at startup, emplace_back() during run, dump on shutdown.
// WHY 10M: at ~5000 depth updates/s + trades, 10M gives ~30 minutes of headroom.
struct LatencyStore {
    std::vector<uint64_t> parse_cycles;   // point1 → point2 (parse latency)
    std::vector<uint64_t> queue_cycles;   // point2 → point3 (queue transit latency)
    std::vector<uint64_t> book_cycles;    // point2 → point4 (parse done -> book-update done)
    std::vector<uint64_t> publish_cycles; // point4 → point5 (book-update done -> mmap publish done)

    void reserve(size_t n = 10'000'000) {
        parse_cycles.reserve(n);
        queue_cycles.reserve(n);
        book_cycles.reserve(n);
        publish_cycles.reserve(n);
    }

    // Cold-path I/O: uses std::ofstream for simplicity 
    // since this runs after trading stops; hot path uses mmap for low-latency writes.
    void dump(const std::string& filepath, double calibrated_ghz) const {
        std::ofstream csv(filepath);
        if (!csv.is_open()) {
            std::cerr << "[LatencyStore] Warning: Could not open " << filepath << " for writing.\n";
            return;
        }

    // Per-stage CSV: recv->parse (simdjson hot path), parse->dequeue (SPSC ring buffer),
    // parse->book-update, and book-update->publish (mmap write).
    // parse_cycles:   rdtscp delta from message arrival to queue push (t1->t2).
    // queue_cycles:   rdtscp delta from queue push to consumer pop (t2->t3).
    // book_cycles:    rdtscp delta from queue push to book-update done (t2->t4).
    // publish_cycles: rdtscp delta from book-update done to mmap publish done (t4->t5).
    // Reported in nanoseconds using the dynamically calibrated TSC frequency.
    csv << "queue_transit_ns,parse_ns,book_update_ns,publish_ns\n";

    // Zip all four vectors — use the shortest to avoid out-of-bounds if counts diverge.
    // They should always match (one entry per tick) but defensive sizing is correct here.
    size_t n = std::min({queue_cycles.size(), parse_cycles.size(),
                          book_cycles.size(), publish_cycles.size()});
    if (parse_cycles.empty()) {
        std::cerr << "[LatencyStore] WARNING: parse_cycles is empty — "
                  << "check that dispatch() calls latency_.parse_cycles.emplace_back()\n";
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