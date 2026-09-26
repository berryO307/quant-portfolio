#pragma once
#include "spsc_ring_buffer.hpp"
#include "types.hpp"   // PriceLevel
#include "rdtsc.hpp"   // tsc_to_ns
#include "live_histogram.hpp"
#include "thread_utils.hpp"   // pin_thread_off_hot_cores
#include <zlib.h>
#include <atomic>
#include <thread>
#include <chrono>
#include <string>
#include <cstdio>
#include <functional>
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

// COARSE_SNAPSHOT: same shape as SNAPSHOT (ExportSnapshot), sourced from a
// second, wider-rounded l2Book subscription instead of the primary book —
// see Channel::CoarseDepth in market_data_source.hpp for why this exists.
enum class ExportRecordType : uint8_t { SAMPLE = 0, SNAPSHOT = 1, TRADE = 2, COARSE_SNAPSHOT = 3 };

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

// Per-tick stage-timestamp sample: recv/parse/pop/book-update/publish, plus
// context.
//
// The four timestamps are cumulative points on one timeline, so every stage
// is a difference between two adjacent ones. t_pop exists because the naive
// difference was measuring the wrong thing: t_recv..t_parse happens on the
// adapter thread and t_book..t_publish on the consumer thread, so t_book -
// t_parse silently spanned the queue AND the consumer's wake-up. Measured
// live, that made "book update" read as 5.4ms at p99 against a 300ns publish
// stage. Splitting at t_pop separates queue wait (t_pop - t_parse) from the
// book update itself (t_book - t_pop).
//
// Previously also carried t_parse_begin (a marginal, not cumulative, parse
// cost per tick within a batched frame), host_jitter_ns (ambient host
// scheduling noise from a dedicated canary thread), and queue_depth (SPSC
// queue size at pop) — removed as a deliberate project-scope decision: this
// gateway measures its own hot-path work (parse/queue/book/publish), not the
// host machine's scheduler behavior, and the deployment target (a Linux
// server) doesn't have the Windows-scheduler-quantum noise those existed to
// diagnose. See git history if any of the three is ever needed again.
struct ExportSample {
    uint64_t   t_recv;       // rdtscp at frame recv (== Tick::t1_tsc; shared across a batch)
    uint64_t   t_parse;      // rdtscp at parse done   (== Tick::t2_tsc / NormalizedTick::t2_tsc)
    uint64_t   t_pop;        // rdtscp at consumer queue pop, before the book update
    uint64_t   t_book;       // rdtscp at book-update done
    uint64_t   t_publish;    // rdtscp at mmap publish done
    uint16_t   batch_index;  // position within the arriving frame (see Tick::batch_index)
    uint16_t   batch_size;   // tick count of that frame; 1 when it carried a single tick
    // Cumulative count of SpscRingBuffer::push() returning false (ring full,
    // tick silently dropped) across BOTH the depth and trades queues, as of
    // THIS sample — a running total sampled alongside it, not a per-tick
    // delta. Kept deliberately: this is data-completeness (did the order
    // book miss a real tick), not a latency measurement, so it stayed when
    // t_parse_begin/host_jitter_ns/queue_depth were removed.
    uint64_t   queue_overflow_dropped;
    SampleSide side;
    uint8_t    cpu_core_id;
};

// Periodic top-of-book snapshot. Fixed depth (not the full ladder) so every
// ring slot has a bounded, known size regardless of record type.
//
// Was 10, then 50 (still well inside the in-memory OrderBook's own 200-level
// depth, so no upstream limitation to work around). Bumped again to 100 so
// the web depth curve's level-count selector (a min-50 floor, ceiling
// tracking whatever this constant provides) has actual headroom above its
// floor instead of collapsing to a single greyed-out option.
static constexpr size_t EXPORT_SNAPSHOT_DEPTH = 100;

struct ExportSnapshot {
    uint64_t   tsc;
    int32_t    bid_count;   // <= EXPORT_SNAPSHOT_DEPTH, best price first
    int32_t    ask_count;   // <= EXPORT_SNAPSHOT_DEPTH, best price first
    PriceLevel bids[EXPORT_SNAPSHOT_DEPTH];
    PriceLevel asks[EXPORT_SNAPSHOT_DEPTH];
    // 0 for a real SNAPSHOT record (the primary, unrounded book) or a
    // COARSE_SNAPSHOT sourced from Hyperliquid's own nSigFigs rounding
    // otherwise -- see Channel::CoarseDepth. A single fixed coarse tier
    // turned out not to be enough: bucketing a snapshot whose OWN native
    // level spacing is already wider than the requested display bucket is a
    // no-op, which is why every bucket size from 5 up to 1000 rendered
    // identically once there was only one (nSigFigs=2) coarse source.
    // Multiple tiers, each tagged with the nSigFigs that produced it, let
    // the web layer pick whichever available snapshot's own native spacing
    // actually fits the bucket size the viewer selected -- see
    // lib/orderBook.ts's pickBestSnapshot.
    // No default member initializer (would make ExportSnapshot non-trivially
    // constructible, which breaks ExportRecord's union -- every existing
    // `ExportRecord rec{};` site relies on trivial, all-zero construction).
    // ExportRecord{} value-initializes this to 0 regardless.
    int32_t    nsigfigs;
};

struct ExportTrade {
    uint64_t   tsc;
    int64_t    price;
    int64_t    qty;
    int64_t    trade_id;
    SampleSide side;   // BID or ASK — the resting side the trade printed against
    // The exchange's OWN trade timestamp (Hyperliquid's wire "time" field,
    // epoch milliseconds — see HyperliquidAdapter::parse_trade), not a
    // gateway-local one. Added because the web app had no exchange-sourced
    // time for a trade at all: TradesTape.tsx was displaying `Date.now()`
    // captured in the BROWSER when the relay's WS message arrived —
    // network + pipeline transit time added on top of whatever the
    // exchange itself reports for the trade, which is why it never lined
    // up with Hyperliquid's own displayed time for the same trade. `tsc`
    // above is a local hardware cycle count relative to this process's
    // own calibration and was never meant to answer "when did this trade
    // happen on the exchange" at all.
    int64_t    event_time_ms;
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

// One JSON-line serializer, shared by ColdPathExporter's local .ndjson.gz
// write and RelayPushClient's live WS push (see relay_push_client.hpp) —
// the same field names/shapes relay/src/types.ts validates against. A
// second, independently-written serializer for the same record is exactly
// the "two copies of the same value" bug class BUGS.md #23 already caught
// once in this codebase (a drifted price marker); not repeating that here
// for the wire format.
inline std::string export_record_to_json(const ExportRecord& rec) {
    char buf[1024];
    switch (rec.type) {
    case ExportRecordType::SAMPLE: {
        const auto& s = rec.sample;
        int n = std::snprintf(buf, sizeof(buf),
            "{\"type\":\"sample\",\"t_recv\":%llu,"
            "\"t_parse\":%llu,\"t_pop\":%llu,\"t_book\":%llu,"
            "\"t_publish\":%llu,"
            "\"batch_index\":%u,\"batch_size\":%u,\"queue_overflow_dropped\":%llu,"
            "\"side\":\"%s\",\"cpu_core\":%u}",
            static_cast<unsigned long long>(s.t_recv),
            static_cast<unsigned long long>(s.t_parse),
            static_cast<unsigned long long>(s.t_pop),
            static_cast<unsigned long long>(s.t_book),
            static_cast<unsigned long long>(s.t_publish),
            static_cast<unsigned>(s.batch_index),
            static_cast<unsigned>(s.batch_size),
            static_cast<unsigned long long>(s.queue_overflow_dropped),
            side_to_str(s.side),
            static_cast<unsigned>(s.cpu_core_id));
        return std::string(buf, n > 0 ? static_cast<size_t>(n) : 0);
    }
    case ExportRecordType::SNAPSHOT: {
        const auto& snap = rec.snapshot;
        std::string out = "{\"type\":\"snapshot\",\"tsc\":" + std::to_string(snap.tsc) + ",\"bids\":[";
        for (int i = 0; i < snap.bid_count; ++i) {
            if (i) out += ',';
            out += '[' + std::to_string(snap.bids[i].price) + ',' + std::to_string(snap.bids[i].qty) + ']';
        }
        out += "],\"asks\":[";
        for (int i = 0; i < snap.ask_count; ++i) {
            if (i) out += ',';
            out += '[' + std::to_string(snap.asks[i].price) + ',' + std::to_string(snap.asks[i].qty) + ']';
        }
        out += "]}";
        return out;
    }
    case ExportRecordType::COARSE_SNAPSHOT: {
        // Same ExportSnapshot shape as SNAPSHOT above, reused via rec.snapshot
        // (they're the same union member — only the type tag differs); only
        // the JSON "type" string differs downstream, so the web/relay layers
        // can tell which price rounding a given snapshot came from.
        const auto& snap = rec.snapshot;
        std::string out = "{\"type\":\"coarse_snapshot\",\"nsigfigs\":" + std::to_string(snap.nsigfigs) +
                           ",\"tsc\":" + std::to_string(snap.tsc) + ",\"bids\":[";
        for (int i = 0; i < snap.bid_count; ++i) {
            if (i) out += ',';
            out += '[' + std::to_string(snap.bids[i].price) + ',' + std::to_string(snap.bids[i].qty) + ']';
        }
        out += "],\"asks\":[";
        for (int i = 0; i < snap.ask_count; ++i) {
            if (i) out += ',';
            out += '[' + std::to_string(snap.asks[i].price) + ',' + std::to_string(snap.asks[i].qty) + ']';
        }
        out += "]}";
        return out;
    }
    case ExportRecordType::TRADE: {
        const auto& t = rec.trade;
        int n = std::snprintf(buf, sizeof(buf),
            "{\"type\":\"trade\",\"tsc\":%llu,\"price\":%lld,\"qty\":%lld,"
            "\"trade_id\":%lld,\"side\":\"%s\",\"event_time_ms\":%lld}",
            static_cast<unsigned long long>(t.tsc),
            static_cast<long long>(t.price),
            static_cast<long long>(t.qty),
            static_cast<long long>(t.trade_id),
            side_to_str(t.side),
            static_cast<long long>(t.event_time_ms));
        return std::string(buf, n > 0 ? static_cast<size_t>(n) : 0);
    }
    }
    return {};
}

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
    // on_record: optional, called on THIS class's own drain thread for every
    // record right after it's written locally — the "future consumer" the
    // comment above anticipated. A std::function rather than a concrete type
    // (e.g. RelayPushClient*) so this header stays decoupled from whatever
    // that consumer is; main.cpp is the only place that wires the two
    // together. Must not block — see RelayPushClient::push()'s own contract
    // for why (this drain thread has its own backpressure duties already).
    ColdPathExporter(ExportRingBuffer& ring, double cpu_ghz, LiveHistogram& histogram,
                      const std::string& out_dir = "data/export",
                      std::function<void(const ExportRecord&)> on_record = nullptr)
        : ring_(ring), cpu_ghz_(cpu_ghz), histogram_(histogram), on_record_(std::move(on_record)),
          running_(true) {
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
        if (rec.type == ExportRecordType::SAMPLE) {
            // Live histogram update — this IS the drain thread, per the Phase 3
            // requirement that this never runs on the trading/gateway thread.
            const auto& s = rec.sample;
            histogram_.record(tsc_to_ns(s.t_publish - s.t_recv, cpu_ghz_));
        }

        const std::string json = export_record_to_json(rec);
        gzputs(gz_, json.c_str());
        gzputc(gz_, '\n');

        // Live push (if wired up) — see the constructor's on_record comment.
        // Fire-and-forget from this thread's point of view: on_record_ owns
        // whatever queueing/backpressure it needs internally, exactly like
        // ring_.push() itself never blocks this thread on a full buffer.
        if (on_record_) on_record_(rec);
    }

    void drain() {
        // This thread runs zlib deflate on every record plus a blocking
        // write() whenever zlib's buffer fills — genuinely heavy, cold-path
        // work. It was previously unpinned, so the OS was free to schedule
        // it onto the producer/consumer/canary cores. Keep it off them.
        pin_thread_off_hot_cores("export_drain");
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
    std::function<void(const ExportRecord&)> on_record_;
    std::string          path_;
    gzFile               gz_ = nullptr;
    std::atomic<bool>    running_;
    std::atomic<uint64_t> dropped_{0};
    std::thread          drain_thread_;
};
