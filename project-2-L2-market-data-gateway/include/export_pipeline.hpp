#pragma once
#include "spsc_ring_buffer.hpp"
#include "types.hpp"   // PriceLevel
#include "rdtsc.hpp"   // tsc_to_ns
#include "live_histogram.hpp"
#include <zlib.h>
#include <atomic>
#include <thread>
#include <chrono>
#include <string>
#include <filesystem>
#include <stdexcept>
#include <iostream>

#ifdef _WIN32
#include <windows.h>
#else
#include <sched.h>
#endif

// Cold-path sample/snapshot/trade export pipeline.
//
// Design: a single SPSC ring buffer carries three tagged record kinds (per-tick
// latency sample, periodic L2 snapshot, trade print) from the gateway/consumer
// thread (the one producer) to a dedicated drain thread (the one consumer),
// which writes them out as gzip-compressed NDJSON. One ring buffer instead of
// three keeps this a strict single-producer/single-consumer channel, matching
// the project rule that cross-thread communication must go through lock-free
// queues, never direct shared access (the drain thread has no other way to see
// book/trade state, which the consumer thread owns exclusively).
//
// All records carry raw rdtscp TSC values (not deltas, not ns) — the same
// clock already embedded as NormalizedTick::t2_tsc in ticks.bin — so exported
// rows can be correlated with ticks.bin/latency.csv by matching TSC values
// directly, without compounding any ns-conversion rounding.

// Cheap: reads a per-thread/per-CPU value, not a synchronizing call.
inline int current_cpu_core() {
#ifdef _WIN32
    return static_cast<int>(GetCurrentProcessorNumber());
#else
    return sched_getcpu();
#endif
}

enum class ExportRecordType : uint8_t { SAMPLE = 0, SNAPSHOT = 1, TRADE = 2 };

// NONE: trade tick, no depth side (unused). BID/ASK: which side a depth update
// touched, or the resting side a trade printed against (is_buyer_maker==true
// means the seller was the taker, i.e. the trade printed against the bid).
enum class SampleSide : uint8_t { NONE = 0, BID = 1, ASK = 2, BOTH = 3 };

inline const char* side_to_str(SampleSide s) {
    switch (s) {
        case SampleSide::BID:  return "bid";
        case SampleSide::ASK:  return "ask";
        case SampleSide::BOTH: return "both";
        default:                return "none";
    }
}

// Per-tick stage-timestamp sample: recv/parse/book-update/publish, plus context.
struct ExportSample {
    uint64_t   t_recv;       // rdtscp at message recv (== Tick::t1_tsc)
    uint64_t   t_parse;      // rdtscp at parse done   (== Tick::t2_tsc / NormalizedTick::t2_tsc)
    uint64_t   t_book;       // rdtscp at book-update done
    uint64_t   t_publish;    // rdtscp at mmap publish done
    uint32_t   queue_depth;  // source SPSC queue size, sampled at pop time
    SampleSide side;
    uint8_t    cpu_core_id;
};

// Periodic top-of-book snapshot. Fixed depth (not the full ladder) so every
// ring slot has a bounded, known size regardless of record type.
static constexpr size_t EXPORT_SNAPSHOT_DEPTH = 10;

struct ExportSnapshot {
    uint64_t   tsc;
    int32_t    bid_count;   // <= EXPORT_SNAPSHOT_DEPTH, best price first
    int32_t    ask_count;   // <= EXPORT_SNAPSHOT_DEPTH, best price first
    PriceLevel bids[EXPORT_SNAPSHOT_DEPTH];
    PriceLevel asks[EXPORT_SNAPSHOT_DEPTH];
};

struct ExportTrade {
    uint64_t   tsc;
    int64_t    price;
    int64_t    qty;
    int64_t    trade_id;
    SampleSide side;   // BID or ASK — the resting side the trade printed against
};

// Tagged union: every slot is sized to the largest member (ExportSnapshot),
// which keeps this a single fixed-size SPSC channel instead of three.
struct ExportRecord {
    ExportRecordType type;
    union {
        ExportSample   sample;
        ExportSnapshot snapshot;
        ExportTrade    trade;
    };
};

// ~340 bytes/slot * 65536 =~ 22MB, heap-allocated once at startup (see main.cpp,
// same precedent as OrderBook being too big for a thread stack). At ~5000
// msg/s that's ~13s of absorption if the drain thread stalls before samples
// start dropping.
static constexpr size_t EXPORT_RING_CAPACITY = 65536;
using ExportRingBuffer = SpscRingBuffer<ExportRecord, EXPORT_RING_CAPACITY>;

// Drains an ExportRingBuffer on a dedicated thread and writes gzip-compressed
// NDJSON, one line per record. The ring buffer itself is owned by the caller
// (it's also referenced by the producer side), not by this class.
class ColdPathExporter {
public:
    // cpu_ghz: calibrated TSC frequency (see calibrate_tsc_ghz()), used only to
    // convert each sample's t_recv->t_publish TSC delta into ns for the live
    // histogram — the NDJSON output itself still stores raw TSC values.
    // histogram: owned by the caller (see main.cpp), not by this class, so a
    // future consumer can hold the same reference without touching this file.
    ColdPathExporter(ExportRingBuffer& ring, double cpu_ghz, LiveHistogram& histogram,
                      const std::string& out_dir = "data/export")
        : ring_(ring), cpu_ghz_(cpu_ghz), histogram_(histogram), running_(true) {
        std::filesystem::create_directories(out_dir);

        auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        path_ = out_dir + "/session_" + std::to_string(now_ms) + ".ndjson.gz";

        gz_ = gzopen(path_.c_str(), "wb");
        if (!gz_) {
            throw std::runtime_error("ColdPathExporter: failed to open " + path_);
        }
        std::cout << "[export] writing cold-path session to " << path_ << "\n";

        drain_thread_ = std::thread([this]() { drain(); });
    }

    ~ColdPathExporter() {
        running_.store(false, std::memory_order_release);
        if (drain_thread_.joinable()) drain_thread_.join();
        if (gz_) gzclose(gz_);
    }

    ColdPathExporter(const ColdPathExporter&)            = delete;
    ColdPathExporter& operator=(const ColdPathExporter&) = delete;

    // Called by the GATEWAY (producer) thread only. Never blocks: on
    // backpressure (ring full because the drain thread fell behind) it drops
    // the record and counts it, exactly like SpscRingBuffer::push() already
    // signals via its bool return.
    bool push(const ExportRecord& rec) {
        if (ring_.push(rec)) return true;
        dropped_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

private:
    void write_record(const ExportRecord& rec) {
        switch (rec.type) {
        case ExportRecordType::SAMPLE: {
            const auto& s = rec.sample;

            // Live histogram update — this IS the drain thread, per the Phase 3
            // requirement that this never runs on the trading/gateway thread.
            histogram_.record(tsc_to_ns(s.t_publish - s.t_recv, cpu_ghz_));

            gzprintf(gz_,
                "{\"type\":\"sample\",\"t_recv\":%llu,\"t_parse\":%llu,\"t_book\":%llu,"
                "\"t_publish\":%llu,\"queue_depth\":%u,\"side\":\"%s\",\"cpu_core\":%u}\n",
                static_cast<unsigned long long>(s.t_recv),
                static_cast<unsigned long long>(s.t_parse),
                static_cast<unsigned long long>(s.t_book),
                static_cast<unsigned long long>(s.t_publish),
                static_cast<unsigned>(s.queue_depth),
                side_to_str(s.side),
                static_cast<unsigned>(s.cpu_core_id));
            break;
        }
        case ExportRecordType::SNAPSHOT: {
            const auto& snap = rec.snapshot;
            gzprintf(gz_, "{\"type\":\"snapshot\",\"tsc\":%llu,\"bids\":[",
                      static_cast<unsigned long long>(snap.tsc));
            for (int i = 0; i < snap.bid_count; ++i) {
                gzprintf(gz_, "%s[%lld,%lld]", i ? "," : "",
                          static_cast<long long>(snap.bids[i].price),
                          static_cast<long long>(snap.bids[i].qty));
            }
            gzprintf(gz_, "],\"asks\":[");
            for (int i = 0; i < snap.ask_count; ++i) {
                gzprintf(gz_, "%s[%lld,%lld]", i ? "," : "",
                          static_cast<long long>(snap.asks[i].price),
                          static_cast<long long>(snap.asks[i].qty));
            }
            gzprintf(gz_, "]}\n");
            break;
        }
        case ExportRecordType::TRADE: {
            const auto& t = rec.trade;
            gzprintf(gz_,
                "{\"type\":\"trade\",\"tsc\":%llu,\"price\":%lld,\"qty\":%lld,"
                "\"trade_id\":%lld,\"side\":\"%s\"}\n",
                static_cast<unsigned long long>(t.tsc),
                static_cast<long long>(t.price),
                static_cast<long long>(t.qty),
                static_cast<long long>(t.trade_id),
                side_to_str(t.side));
            break;
        }
        }
    }

    void drain() {
        ExportRecord rec;
        while (running_.load(std::memory_order_acquire)) {
            bool got_any = false;
            // Bounded inner loop: drain a batch before re-checking running_/sleeping,
            // so a burst doesn't force per-record context switches.
            for (int i = 0; i < 256 && ring_.pop(rec); ++i) {
                write_record(rec);
                got_any = true;
            }
            if (!got_any) {
                std::this_thread::sleep_for(std::chrono::microseconds(500));
            }
        }

        // Final drain after stop is requested, so nothing queued at shutdown is lost.
        while (ring_.pop(rec)) write_record(rec);

        gzflush(gz_, Z_FINISH);

        uint64_t d = dropped();
        if (d > 0) {
            std::cerr << "[export] WARNING: dropped " << d
                      << " records — drain thread fell behind the ring buffer\n";
        }
        std::cout << "[export] session closed: " << path_ << " (dropped=" << d << ")\n";
    }

    ExportRingBuffer&    ring_;
    double               cpu_ghz_;
    LiveHistogram&       histogram_;
    std::string          path_;
    gzFile               gz_ = nullptr;
    std::atomic<bool>    running_;
    std::atomic<uint64_t> dropped_{0};
    std::thread          drain_thread_;
};
