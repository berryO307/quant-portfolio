#include "types.hpp"
#include "spsc_ring_buffer.hpp"
#include "order_book.hpp"
#include "market_data_source.hpp"
#include "hyperliquid_adapter.hpp"
#include "coarse_book_state.hpp"
#include "mmap_writer.hpp"
#include "rdtsc.hpp"
#include "thread_utils.hpp"
#include "export_pipeline.hpp"
#include "relay_push_client.hpp"
#include "live_histogram.hpp"
#include "terminal_progress.hpp"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <unistd.h>
#include <vector>
#include <cerrno>
#include <cstring>
#include <pthread.h>
#include <sched.h>

// Globals for signal handler
static std::atomic<bool> g_stop{false};

static void signal_handler(int) {
    g_stop.store(true, std::memory_order_relaxed);
    // Minimal signal handler by design—only lock-free state mutation
    // and async-signal-safe write() to avoid reentrancy, deadlock, and Undefined Behavior.
    static const char msg[] = "\n[main] stop requested\n";
    write(STDOUT_FILENO, msg, sizeof(msg) - 1);
}

// FIX 1: Consumer Data Pipeline: pop ticks, update book, write CSV
// NOTE: Consumer thread owns all book mutation;
// cross-thread communication should occur via lock-free queues, never direct shared access.
static void consumer_loop(SpscRingBuffer<Tick, 1024>& depth_queue,
                        SpscRingBuffer<Tick, 1024>& trade_queue,
                        std::atomic<bool>& stop,
                        LatencyStore& latency,
                        MmapWriter& mmap_writer,
                        std::atomic<uint64_t>& last_u,
                        ColdPathExporter& exporter,
                        const std::atomic<uint64_t>& queue_overflow_dropped,
                        CoarseTier (&coarse_tiers)[COARSE_TIER_COUNT]) {

    // NOTE: OrderBook is heap-allocated and owned exclusively by this consumer thread
    // via unique_ptr — no shared mutable state, no locks required.
    // Cache performance is determined by access locality in apply_depth(), not
    // allocation location. Stack allocation is not viable at 32MB (exceeds thread
    // stack limit); heap allocation has identical steady-state cache behavior.
    auto book_ptr = std::make_unique<OrderBook>();
    OrderBook& book = *book_ptr;

    // Persistent State: Survives resyncs
    uint64_t total_ticks    = 0;
    uint64_t depth_applied  = 0;
    uint64_t depth_dropped  = 0;
    uint64_t trade_count    = 0;
    uint64_t gap_count      = 0;

    // Ticks parsed BEFORE the book finished seeding. They are still processed
    // normally — they are real market data — but their stage timings are not
    // pipeline latency: a trade parsed during the pre-seed wait sits in the ring
    // until the first depth snapshot arrives and seeds the book, so its "queue
    // wait" measures the seed protocol instead.
    //
    // Live evidence (27-minute BTC session, n=5204): every sample above 1 ms in
    // the entire run — all 30 of them — landed at t=0.0 s inside a single
    // batch_size=30 frame. Not one occurred after startup. Recorded, they pin
    // p99.9 at 10.5 ms forever while describing the seed handshake rather than
    // this pipeline.
    //
    // Counted rather than silently dropped (same discipline as
    // queue_overflow_dropped), and re-armed on every RESYNC because a
    // gap-driven resync reproduces the artifact exactly.
    uint64_t t_seed_complete_tsc = 0;
    uint64_t pre_seed_skipped    = 0;

    // Declare the flag here so it persists across loop iterations
    bool just_resynced = true;

    // State machine for Binance L2 sync protocol
    enum class State { Init, Syncing, InSync };
    State state = State::Init;

    auto t_start    = std::chrono::steady_clock::now();
    auto t_last_log = t_start;
    auto t_last_export_snapshot = t_start;
    // Floor, not a fixed sample rate — see the export-trigger site below
    // (inside the depth branch) for why this changed from a flat 1/s.
    // Still caps the export rate during a genuinely bursty period: humans
    // can't perceive book updates faster than this anyway, and it bounds
    // export-ring/relay-push load regardless of how fast Hyperliquid's own
    // feed gets.
    static constexpr auto MIN_SNAPSHOT_INTERVAL = std::chrono::milliseconds(100);

    RESYNC:
    state         = State::Init;
    just_resynced = true;

    // Wait for WS to actually connect and push data
    std::cout << "[consumer] waiting for WS buffer...\n";
    while (depth_queue.empty() && trade_queue.empty() &&
            !stop.load(std::memory_order_relaxed)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    // Exit gracefully if stopped while waiting
    if (stop.load(std::memory_order_relaxed)) return;

    // Hyperliquid's l2Book pushes a full snapshot on every message (pu==0
    // on every DepthUpdate — see HyperliquidAdapter's header comment), so
    // the very first depth message received already seeds the book; no
    // REST bootstrap needed (rest_client.cpp, Bybit-specific, was removed
    // along with BybitAdapter).
    std::cout << "[consumer] waiting for WS snapshot...\n";
    bool seeded_from_ws = false;
    
    while (!seeded_from_ws && !stop.load(std::memory_order_relaxed)) {
        Tick init_tick;
        bool got_tick = false;
        
        // With adaptive backoff: spin briefly, then yield, then sleep
        if (!got_tick) {
        // Spin a few times — if data arrives within ~1µs, we don't sleep at all
        for (int i = 0; i < 10; ++i) {
        if (depth_queue.pop(init_tick) || trade_queue.pop(init_tick)) {
            got_tick = true;
            break;
        }
        // PAUSE instruction hint to the CPU (frees execution units, reduces power)
        #ifdef __x86_64__
        __builtin_ia32_pause();
        #endif
        }
        if (!got_tick) {
        std::this_thread::yield();   // give other threads a turn, no fixed sleep
        continue;
        }
    }
        
        if (auto* depth = std::get_if<DepthUpdate>(&init_tick.data)) {
        // Full-snapshot marker: pu==0 (set by HyperliquidAdapter::parse_depth
        // on every message — l2Book has no delta protocol at all)
            if (depth->pu == 0) {
                OrderBookSnapshot snap;
                snap.last_update_id = depth->u;
                snap.bids           = depth->bids;
                snap.asks           = depth->asks;
                
                book.resync(std::move(snap));
                last_u.store(depth->u, std::memory_order_release);
                
                std::cout << "[consumer] book seeded from WS snapshot, u=" << depth->u
                          << "  bids=" << depth->bids.size()
                          << "  asks=" << depth->asks.size() << "\n";
                          
                seeded_from_ws = true;
                state = State::InSync;   // skip Syncing, WS snapshot IS the seed

                // Anything already parsed and sitting in the ring at this
                // instant predates a usable book — see pre_seed_skipped.
                t_seed_complete_tsc = rdtscp();
            }
            // Non-snapshot depth events before the snapshot are dropped — normal during init
        }
    }
    
    if (stop.load(std::memory_order_relaxed)) return;

    // Bounded spin budget for the empty-queue case below: enough pop()
    // attempts to catch a tick that arrives within a few microseconds
    // without ever calling into the OS scheduler, small enough that a
    // genuinely idle stretch (this feed runs ~3-13 ticks/sec, so idle
    // stretches are the common case, not the exception) still falls
    // through to sleep quickly. Not tuned to a specific number of
    // microseconds — see FIX 2's comment below for why a time-based
    // budget isn't the point here.
    static constexpr int kPopSpinIters = 256;

    while (!stop.load(std::memory_order_relaxed)) {
        // FIX 2 (original): Replaced blocking pop_for() (ThreadQueue condvar API)
        // with non-blocking SpscRingBuffer::pop() + microsecond sleep — still true,
        // SpscRingBuffer has no condvar/mutex to block on.
        //
        // FIX 2 (this round): the plain sleep_for(100us) that used to sit directly
        // below is not reliable at that resolution on Windows — measured live,
        // a bare sleep_for(100us) here returned in either a near-no-op or,
        // occasionally, multi-millisecond — the OS timer quantum, not a fixed
        // 100us floor. Live evidence: comparing queue_ns for pops that left the
        // queue empty afterward, BEFORE this fix, showed p90=11-12ms and
        // max=15-16ms on both BTC and WTI — nearly identical to the backlogged
        // case, which a "just the pipeline is busy" explanation wouldn't predict.
        //
        // Fixed by the same spin+pause backoff already used a few dozen lines up
        // for the pre-seed wait (same file): try pop() with a PAUSE hint between
        // attempts for a bounded number of iterations first — cheap, and catches
        // the common case of a tick landing microseconds after the last check —
        // and only fall back to sleep_for once genuinely idle, so this thread
        // isn't pegging a core at 100% during the real dead time between bursts.
        Tick tick;
        bool got_tick = false;
        for (int spin = 0; spin < kPopSpinIters; ++spin) {
            if (depth_queue.pop(tick)) {
                got_tick = true;
                break;
            }
            if (trade_queue.pop(tick)) {
                got_tick = true;
                break;
            }
#ifdef __x86_64__
            __builtin_ia32_pause();
#endif
        }
        if (!got_tick) {
            std::this_thread::sleep_for(std::chrono::microseconds(100));
    continue;
        }

        uint64_t t3 = rdtscp();

        // See pre_seed_skipped's declaration: a tick parsed before the book was
        // seeded carries a queue wait that measures the seed protocol, not this
        // pipeline. Process it, but do not measure it.
        const bool pre_seed = tick.t2_tsc < t_seed_complete_tsc;
        if (pre_seed) ++pre_seed_skipped;

        // All four stage vectors are appended here, on this thread, for this tick,
        // under this one filter — LatencyStore::dump() zips them by index, so any
        // stage recorded elsewhere (parse used to be recorded on the producer)
        // silently misaligns every CSV row. Nothing is recorded here — see the
        // single record site after t5. This
        // iteration can still abandon the tick via `goto RESYNC` (sequence gap, or
        // apply_depth rejecting it), which would leave queue/parse recorded and
        // book/publish not, shifting every later row of the zipped CSV. Observed as
        // queue=800 parse=800 book=798 publish=798 on a 3-minute run.
        ++total_ticks;

        NormalizedTick out{};   // zero-initialise all fields
        SampleSide sample_side = SampleSide::NONE;   // export context only, set below
        // NOTE: NormalizedTick::stream_type is a SIGNED 1-bit field, so it can only
        // ever hold 0 or -1 — assigning 1 (below, pre-existing) silently stores -1.
        // Don't compare against it; track trade-ness separately for export purposes.
        bool is_trade_tick = false;
        // Set by the depth branch, acted on after this tick is published — see
        // the snapshot block near the end of the loop for why it moved there.
        bool want_snapshot = false;

        // Fields common to both stream types
        out.t2_tsc   = tick.t2_tsc;
        out.best_bid = book.best_bid();
        out.best_ask = book.best_ask();

        // Using get_if to guarantee zero exception overhead and a single tag check
        if (auto* depth = std::get_if<DepthUpdate>(&tick.data)) {
            // Export context: which side(s) this depth message touched.
            bool has_bids = !depth->bids.empty();
            bool has_asks = !depth->asks.empty();
            sample_side = (has_bids && has_asks) ? SampleSide::BOTH
                        : has_bids               ? SampleSide::BID
                        : has_asks               ? SampleSide::ASK
                        :                          SampleSide::NONE;

            if (state == State::Syncing) {
                // Stale: discard events older than snapshot (strict less-than per Binance spec)
                if (static_cast<uint64_t>(depth->u) < last_u.load(std::memory_order_acquire)) {
                    ++depth_dropped;
                    continue;
                }

                // Overlap check: U <= lastUpdateId AND u >= lastUpdateId
                // The >= catches the pivot event (u == lastUpdateId) correctly
                if (static_cast<uint64_t>(depth->U) <= last_u.load(std::memory_order_acquire) &&
                    static_cast<uint64_t>(depth->u) >= last_u.load(std::memory_order_acquire)) {

                    state = State::InSync;

                    // Let book handle application
                    if (!book.apply_depth(*depth)) {
                        std::cerr << "[consumer] initial apply_depth failed. Resyncing...\n";
                        goto RESYNC;
                    }

                    last_u.store(static_cast<uint64_t>(depth->u), std::memory_order_release);
                    ++depth_applied;

                    out.u            = depth->u;
                    out.is_gap_resync = just_resynced ? 1 : 0;
                    just_resynced    = false;

                } else {
                    std::cerr << "[consumer] no overlap (U=" << depth->U
                              << " u=" << depth->u
                              << " last_u=" << last_u.load(std::memory_order_acquire)
                              << "). Resyncing...\n";
                    goto RESYNC;
                }

            } else if (state == State::InSync) {
                // Validate contiguity BEFORE touching the book
                // Never let apply_depth see events it shouldn't
                uint64_t current_last_u = last_u.load(std::memory_order_acquire);

                // pu==0 is the established "this message IS a full snapshot"
                // sentinel (see OrderBook::apply_depth, which already treats
                // it as an unconditional reseed regardless of
                // current_last_u). Hyperliquid's l2Book sends this on EVERY
                // message (confirmed live — l2Book has no delta/resync
                // protocol at all, just full-book pushes; the now-removed
                // BybitAdapter only sent it mid-stream rarely), so the
                // delta-continuity check below must not run for it —
                // otherwise every single update would trip this as a "gap"
                // (pu=0 can never equal a nonzero current_last_u) and force
                // a resync loop on every tick.
                if (depth->pu != 0) {
                    // FUTURES GAP LOGIC: 'pu' MUST exactly match the book's current_last_u
                    if (static_cast<uint64_t>(depth->pu) != current_last_u) {
                        ++gap_count;
                        std::cerr << "[consumer] GAP: expected pu=" << current_last_u
                                  << " got pu=" << depth->pu << "\n";
                        goto RESYNC;
                    }
                }

                // Let the book apply the levels. If it still fails (e.g., malformed data), resync.
                if (!book.apply_depth(*depth)) {
                    ++gap_count;
                    std::cerr << "[consumer] GAP DETECTED #" << gap_count
                              << " (book rejected tick). Resyncing...\n";
                    goto RESYNC;
                }

                // Safely commit the new sequence ID and update the writer output
                last_u.store(static_cast<uint64_t>(depth->u), std::memory_order_release);
                ++depth_applied;
                out.u             = depth->u;
                out.is_gap_resync = 0;
            }

            // FIX: removed orphaned duplicate depth_applied / out.u / last_u assignments
            // that previously ran unconditionally after both branches, doubling the increment

            out.event_time     = depth->event_time;
            out.best_bid       = book.best_bid();   // refresh post-apply
            out.best_ask       = book.best_ask();
            out.stream_type    = 0;
            out.is_buyer_maker = -1;                // sentinel: not a trade

            // Snapshot export, triggered by an actually-applied depth
            // change (this branch), not a flat 1/s timer — Hyperliquid's
            // l2Book sends a full book snapshot on every message (no delta
            // protocol; see HyperliquidAdapter's header comment), so
            // matching its own real-time cadence means re-exporting here,
            // on every applied depth tick, floor-limited by
            // MIN_SNAPSHOT_INTERVAL rather than sampled at a fixed rate.
            // Reported live: at the old 1/s sampling, our own ladder
            // visibly lagged behind Hyperliquid's own site, especially at
            // the finest price bucket where every real update is visible.
            want_snapshot = true;

        } else if (auto* tr = std::get_if<AggTrade>(&tick.data)) {
            ++trade_count;

            out.event_time     = tr->event_time;
            out.price          = tr->price;
            out.qty            = tr->qty;
            out.agg_trade_id   = tr->agg_trade_id;
            out.is_buyer_maker = tr->is_buyer_maker ? 1 : 0;
            out.stream_type    = 1;

            // Export context: is_buyer_maker==true means the seller was the taker,
            // i.e. the trade printed against the bid.
            sample_side  = tr->is_buyer_maker ? SampleSide::BID : SampleSide::ASK;
            is_trade_tick = true;

        } else {
            // Defensive programming: Catch unexpected variant types without throwing
            std::cerr << "[consumer] Warning: Unknown tick type received.\n";
            return; // In production code, consider logging this to a file or monitoring system instead of stderr.
        }

        // Stage 3: book-update complete (depth/trade branch above has finished mutating
        // book state / populating `out`). Captured here, before publish, so it covers
        // both the depth and trade paths uniformly.
        uint64_t t4 = rdtscp();
        // t3, not tick.t2_tsc. t2 is stamped at producer push, so t4 - t2 spans
        // the queue wait as well and reported it under the name "book update" —
        // which is why data/latency.csv's book_update_ns column was bit-identical
        // to its queue_transit_ns column at p99 (13,233,000 ns) and at max
        // (13,234,900 ns). export_pipeline.hpp's header already documents the
        // correct split (t_book - t_pop); only this CSV path was wrong.

        // Cold-path trade print: pushed into the export ring buffer, not written
        // synchronously here. Never blocks — see ColdPathExporter::push().
        if (is_trade_tick) {
            ExportRecord trade_rec{};
            trade_rec.type  = ExportRecordType::TRADE;
            // out.event_time was set a few lines up, in the trade branch, from
            // tr->event_time -- the exchange's own wire timestamp for this trade.
            trade_rec.trade = ExportTrade{
                t4, out.price, out.qty, out.agg_trade_id, sample_side, out.event_time
            };
            exporter.push(trade_rec);
        }

        // Single memcpy into mmap — replaces the entire slow csv << string formatting chain
        mmap_writer.write(out);

        // Stage 4: publish complete (mmap write done).
        uint64_t t5 = rdtscp();

        // THE single record site for all four stages. LatencyStore::dump() zips the
        // four vectors by index, so they must be appended together, on one thread,
        // for one tick, under one filter — otherwise row i pairs one tick's parse
        // with another tick's queue wait. Reaching this line means the tick was
        // fully processed, so either all four are appended or none are.
        //   parse   t1..t2   (cumulative through this tick's position in a
        //                     batched frame, not marginal — see types.hpp)
        //   queue   t2..t3
        //   book    t3..t4  (NOT t2..t4: that spans the queue wait and reported it
        //                    as book-update time — the two CSV columns used to be
        //                    bit-identical at p99 and max because of it)
        //   publish t4..t5
        if (!pre_seed) {
            latency.record(latency.parse_cycles,   tick.t2_tsc - tick.t1_tsc);
            latency.record(latency.queue_cycles,   t3 - tick.t2_tsc);
            latency.record(latency.book_cycles,    t4 - t3);
            latency.record(latency.publish_cycles, t5 - t4);
        }

        // Cold-path per-tick sample: the four stage timestamps plus context.
        // Pushed here (after t5), never blocks — see ColdPathExporter::push().
        // Skipped for pre-seed ticks for the same reason their stage timings
        // aren't recorded: the UI's tail-events feed ranks by these samples, and
        // was surfacing the t=0 seed burst as the worst events of the session,
        // each attributed to "queue wait". The tick is still written to the mmap
        // output and, if it's a trade, still exported as a TRADE record — only
        // the latency sample is withheld.
        if (!pre_seed) {
            ExportRecord sample_rec{};
            sample_rec.type   = ExportRecordType::SAMPLE;
            // Designated initialisers: this struct is a list of adjacent
            // timestamps whose neighbours define the stages, so a silent
            // positional shift here would mislabel a stage rather than fail
            // to compile.
            sample_rec.sample = ExportSample{
                .t_recv         = tick.t1_tsc,
                .t_parse        = tick.t2_tsc,
                .t_pop          = t3,
                .t_book         = t4,
                .t_publish      = t5,
                .batch_index    = tick.batch_index,
                .batch_size     = tick.batch_size,
                .queue_overflow_dropped = queue_overflow_dropped.load(std::memory_order_relaxed),
                .side           = sample_side,
                .cpu_core_id    = static_cast<uint8_t>(current_cpu_core())
            };
            exporter.push(sample_rec);
        }

        // Snapshot export. Deliberately down here, AFTER the tick has been
        // written to the mmap output, after t5, and after its latency sample
        // was pushed — not inside the depth branch where it used to sit.
        //
        // Building a snapshot is UI-facing serialisation work: a top_bids /
        // top_asks ladder walk plus a ~3.2KB ExportRecord that is zero-filled
        // on the stack and then copied again into the export ring. Running it
        // between t3 and t4 charged that work to THIS tick's book-update stage
        // and to its end-to-end latency. Measured over 19,405 live samples, the
        // correlation was total:
        //
        //   book stage WITHOUT a snapshot: p50    20 ns, p99    750 ns (n=17,962)
        //   book stage WITH    a snapshot: p50 8,980 ns, p99 11,820 ns (n= 1,443)
        //
        // and 1,442 of those 1,443 spikes had a snapshot stamp inside their own
        // t_pop..t_book window, against 0 of the 17,962 that did not. A 449x
        // jump in a stage that is otherwise 20 ns, visible in the dashboard as a
        // regular sawtooth on the book-update chart.
        //
        // Moving it here does not make the work cheaper — the consumer still
        // does it, and it still delays the NEXT tick. What it fixes is that the
        // cost is no longer attributed to, or paid by, a tick that was already
        // finished. Removing it from the consumer entirely would need a second
        // thread owning its own copy of the book, since the book is owned
        // exclusively by this thread and deliberately has no locks.
        //
        // The book is only read here, and was mutated before t4, so the emitted
        // snapshot is byte-identical to what the old placement produced.
        //
        // Triggered by an actually-applied depth change rather than a flat 1/s
        // timer: Hyperliquid's l2Book sends a full book snapshot on every
        // message (no delta protocol; see HyperliquidAdapter's header), so
        // matching its real cadence means re-exporting on every applied depth
        // tick, floor-limited by MIN_SNAPSHOT_INTERVAL. At the old 1/s sampling
        // our ladder visibly lagged Hyperliquid's own site at the finest price
        // bucket, where every real update shows.
        if (want_snapshot) {
            auto snap_now = std::chrono::steady_clock::now();
            if (snap_now - t_last_export_snapshot >= MIN_SNAPSHOT_INTERVAL) {
                t_last_export_snapshot = snap_now;

                ExportRecord snap_rec{};
                snap_rec.type = ExportRecordType::SNAPSHOT;
                ExportSnapshot& snap = snap_rec.snapshot;
                snap.tsc       = rdtscp();
                snap.bid_count = book.top_bids(snap.bids, static_cast<int>(EXPORT_SNAPSHOT_DEPTH));
                snap.ask_count = book.top_asks(snap.asks, static_cast<int>(EXPORT_SNAPSHOT_DEPTH));
                exporter.push(snap_rec);
            }
        }

        // Coarse-book snapshots: picked up here, not pushed directly by the
        // coarse-book listener threads, because exporter's ring is strict
        // SPSC and this consumer thread is its one and only producer — see
        // coarse_book_state.hpp's own header comment. Checked every tick for
        // EACH tier (cheap: a relaxed atomic load per tier in the common
        // case where nothing new has arrived) rather than on its own timer,
        // since this loop already runs on every tick anyway.
        for (CoarseTier& tier : coarse_tiers) {
            std::vector<PriceLevel> coarse_bids, coarse_asks;
            uint64_t coarse_tsc = 0;
            if (tier.state.take(coarse_bids, coarse_asks, coarse_tsc)) {
                ExportRecord coarse_rec{};
                coarse_rec.type = ExportRecordType::COARSE_SNAPSHOT;
                ExportSnapshot& snap = coarse_rec.snapshot;
                snap.tsc      = coarse_tsc;
                snap.nsigfigs = tier.nsigfigs;
                snap.bid_count = static_cast<int32_t>(std::min(coarse_bids.size(), EXPORT_SNAPSHOT_DEPTH));
                snap.ask_count = static_cast<int32_t>(std::min(coarse_asks.size(), EXPORT_SNAPSHOT_DEPTH));
                for (int32_t i = 0; i < snap.bid_count; ++i) snap.bids[i] = coarse_bids[static_cast<size_t>(i)];
                for (int32_t i = 0; i < snap.ask_count; ++i) snap.asks[i] = coarse_asks[static_cast<size_t>(i)];
                exporter.push(coarse_rec);
            }
        }

        // Console heartbeat every 10 s
        auto now = std::chrono::steady_clock::now();
        if (now - t_last_log >= std::chrono::seconds(10)) {
            t_last_log = now;
            double elapsed = std::chrono::duration<double>(now - t_start).count();
            std::cout << "[consumer] t=" << std::fixed << std::setprecision(1)
                      << elapsed << "s"
                      << "  ticks="         << total_ticks
                      << "  trades="        << trade_count
                      << "  depth_applied=" << depth_applied
                      << "  dropped="       << depth_dropped
                      << "  queue_overflow_dropped=" << queue_overflow_dropped.load(std::memory_order_relaxed)
                      << "  pre_seed_skipped=" << pre_seed_skipped
                      << "  queue="         << depth_queue.size()
                      << "  bid="  << std::setprecision(2) << (static_cast<double>(out.best_bid) / 10000.0)
                      << "  ask="  << std::setprecision(2) << (static_cast<double>(out.best_ask) / 10000.0)
                      << "  spread=" << book.spread() // Calculated only when needed!
                      << "\n";
        }
    }

    std::cout << "[consumer] done. total_ticks=" << total_ticks
              << "  trades="        << trade_count
              << "  depth_applied=" << depth_applied
              << "  depth_dropped=" << depth_dropped << "\n";
}

// Main
int main(int argc, char* argv[]) {
    // Set process priority to Realtime on Windows for lowest possible latency.
    // Requires Admin privileges. If not run as Admin, Windows does NOT fail
    // this call — SetPriorityClass returns success and silently substitutes
    // HIGH_PRIORITY_CLASS instead (undocumented in the call's own return
    // value, but this is standard, well-known Win32 behavior: an
    // unprivileged caller lacks SeIncreaseBasePriorityPrivilege, and the OS
    // downgrades rather than errors). The original code only checked the
    // return value, so this went completely unnoticed: confirmed live, both
    // gateway processes were running at High, not Realtime, with zero
    // warning ever printed. GetPriorityClass() re-queries what was actually
    // achieved and reports the mismatch explicitly, rather than trusting a
    // Win32 call whose success only means "didn't error," not "did what was asked."
    // On Linux, users can achieve similar results by running with sudo and using chrt to set SCHED_FIFO
    #ifdef _WIN32
    // Set the entire process to Realtime class
    SetPriorityClass(GetCurrentProcess(), REALTIME_PRIORITY_CLASS);
    DWORD achieved_priority = GetPriorityClass(GetCurrentProcess());
    if (achieved_priority != REALTIME_PRIORITY_CLASS) {
        const char* achieved_name =
            achieved_priority == HIGH_PRIORITY_CLASS   ? "High"   :
            achieved_priority == NORMAL_PRIORITY_CLASS ? "Normal" :
            achieved_priority == ABOVE_NORMAL_PRIORITY_CLASS ? "AboveNormal" :
            "other";
        std::cerr << "[main] WARNING: requested REALTIME_PRIORITY_CLASS but the process is "
                     "actually running at " << achieved_name << " (0x" << std::hex
                  << achieved_priority << std::dec << "). Windows silently substitutes a "
                     "lower class instead of failing this call when not run elevated. "
                     "Run as Administrator for true realtime scheduling.\n";
    }
    #else
    // Linux has no process-wide priority class — scheduling policy
    // (SCHED_FIFO/SCHED_RR vs. the default SCHED_OTHER) is per-THREAD, not
    // per-process, which is a real architectural difference from Windows'
    // PriorityClass, not just a naming difference. This call covers the
    // main thread itself; the producer/consumer threads each set
    // their own policy in thread_utils.hpp's configure_self_high_performance()
    // and pin_thread_self(), which now do the same achieved-vs-requested
    // check (see that file).
    //
    // Same discipline as the Windows branch: sched_setscheduler's return
    // value alone only means "didn't error" — an unprivileged caller
    // lacking CAP_SYS_NICE gets EPERM and the policy silently stays
    // SCHED_OTHER, so this re-queries via sched_getscheduler() rather than
    // trusting the call succeeded just because errno wasn't set.
    {
        sched_param param{};
        param.sched_priority = sched_get_priority_max(SCHED_FIFO);
        if (sched_setscheduler(0, SCHED_FIFO, &param) != 0) {
            std::cerr << "[main] WARNING: sched_setscheduler(SCHED_FIFO) failed: "
                      << std::strerror(errno) << " (errno=" << errno << "). "
                         "Requires CAP_SYS_NICE — run with sudo, or grant the capability "
                         "directly: sudo setcap cap_sys_nice=eip <binary>.\n";
        }
        int achieved_policy = sched_getscheduler(0);
        if (achieved_policy != SCHED_FIFO) {
            const char* policy_name =
                achieved_policy == SCHED_OTHER ? "SCHED_OTHER" :
                achieved_policy == SCHED_RR    ? "SCHED_RR"    :
                achieved_policy == SCHED_BATCH ? "SCHED_BATCH" :
                achieved_policy == SCHED_IDLE  ? "SCHED_IDLE"  :
                achieved_policy < 0            ? "unknown (sched_getscheduler failed)" :
                "other";
            std::cerr << "[main] WARNING: requested SCHED_FIFO but the main thread is "
                         "actually running under " << policy_name << " (policy=" << achieved_policy
                      << "). Without CAP_SYS_NICE, Linux silently leaves the default "
                         "time-shared scheduler in place instead of granting real-time "
                         "scheduling — this is the direct Linux analogue of the Windows "
                         "RealTime->High downgrade found in round 8's Fix 3.\n";
        }
    }
    #endif

    // std::signal used intentionally for brevity; production POSIX code should use sigaction() because
    // signal() semantics are historically implementation-dependent and can introduce subtle races.
    std::signal(SIGINT,  signal_handler);
    std::signal(SIGTERM, signal_handler);

    // Core assignments live in thread_utils.hpp rather than as locals here,
    // because the cold-path threads need them too — to stay OFF those cores
    // (see pin_thread_off_hot_cores). This claims a physical core no other
    // running instance holds; running two instruments on one box previously
    // put both consumers on the same core and cost 265x at queue-wait p99.
    // Must run before any thread is spawned.
    configure_hot_cores();
    const int CORE_PRODUCER = hot_cores().producer;
    const int CORE_CONSUMER = hot_cores().consumer;

    // Default: run for 30 minutes unless overridden by argv[1]
    int run_minutes = 30;
    if (argc > 1) run_minutes = std::stoi(argv[1]);

    // Hyperliquid-style symbol: a native coin ("BTC") or a builder-deployed
    // sub-dex coin ("xyz:CL"). Bybit support (and its "btcusdt"-style
    // default) was removed — see market_data_source.hpp's comment.
    std::string symbol = (argc > 2) ? argv[2] : "BTC";

    MarketDataSourceConfig source_cfg;
    source_cfg.symbol = symbol;

    std::cout << "[main] L2DataCapture  source=hyperliquid  symbol=" << symbol
              << "  run=" << run_minutes << "m\n";

    // FIX 3: Replaced ThreadQueue<Tick> with SpscRingBuffer<Tick, 1024>.
    // 1024 slots * sizeof(Tick) bytes each — tune capacity if your Tick struct grows large.
    // Capacity must remain a power of 2 (enforced by static_assert in SpscRingBuffer).
    // SPSC contract: exactly one producer (ws_thread) and one consumer (consumer_thread) —
    // never pass this queue to a second producer or consumer thread.
    // Two ring buffers — one per stream
    SpscRingBuffer<Tick, 1024> depth_queue;
    SpscRingBuffer<Tick, 1024> trade_queue;

    // Coarse-book listeners' own hand-off (see coarse_book_state.hpp) — NOT
    // fed through depth_queue/trade_queue, since a Channel::CoarseDepth
    // adapter never touches those, or the OrderBook, or latency_ at all.
    // The constructor below still requires SOME queue/latency references
    // (they're never invoked for this channel) — a dedicated, otherwise-
    // untouched instance of each avoids any ambiguity about whether these
    // listeners could ever interfere with the real pipeline's own.
    //
    // One tier turned out not to be enough (see coarse_book_state.hpp's own
    // header comment on CoarseTier) — COARSE_TIER_COUNT (from the fixed,
    // instrument-agnostic COARSE_TIERS list) real subscriptions, each its
    // own thread/connection, each its own hand-off slot.
    CoarseTier coarse_tiers[COARSE_TIER_COUNT];
    for (size_t i = 0; i < COARSE_TIER_COUNT; ++i) coarse_tiers[i].nsigfigs = COARSE_TIERS[i];
    SpscRingBuffer<Tick, 1024> coarse_unused_queue;
    LatencyStore coarse_unused_latency; // reserve() deliberately never called: this never records into it

    // Counts SpscRingBuffer::push() returning false (ring full, tick
    // silently dropped) — a failure mode that existed unconditionally
    // before this counter did, with zero visibility. Shared by both
    // adapter instances below (depth-channel and trades-channel each push
    // into their own queue, but a drop on either is worth knowing about
    // the same way), surfaced in the consumer heartbeat log next to the
    // existing dropped=/queue= fields.
    std::atomic<uint64_t> queue_overflow_dropped{0};

    // Initiate the latency store here so it exists before the thread starts
    LatencyStore latency_;

    // reserve() is what makes LatencyStore's "zero heap allocation on hot
    // path" claim true, and it was never actually called — the four
    // std::vectors started at capacity 0 and grew by doubling reallocation
    // for the life of the session, with emplace_back() on EVERY tick from
    // BOTH hot-path threads (parse_cycles on the producer; queue/book/publish
    // on the consumer). Each reallocation is a malloc of the new buffer, a
    // memcpy of everything already stored, and a free of the old one, on the
    // thread that can least afford it. Measured live before this fix: a
    // 3.2-hour session had accumulated ~152k samples per vector (~1.2MB
    // each), and the reallocations land at exponentially spaced tick counts,
    // which is the shape of the occasional huge outlier in the tail (max
    // 50ms against a p99 of 15.8ms).
    //
    // Capacity is bounded rather than sized to the full run: past it,
    // record() drops the sample instead of growing (see LatencyStore), so
    // "no allocation on the hot path" holds for ANY session length rather
    // than only until the reservation runs out. The per-sample NDJSON export
    // carries strictly more information than this CSV anyway, so a capped
    // CSV loses nothing that isn't already recorded elsewhere.
    latency_.reserve();

    // Instantiate the MmapWriter.
    // We need to give it a binary file path (not .csv) and a maximum capacity.
    // Let's pre-allocate space for 10 million ticks (adjust as needed for run time).
    size_t max_expected_ticks = 10000000;
    MmapWriter mmap_writer("data/ticks.bin", max_expected_ticks);

    // Transient State: Resets on resync
    std::atomic<uint64_t> last_u{0};

    // Calibrate TSC first so all latency measurements use a correct GHz baseline;
    // printing is just for verification, not part of the timing logic.
    double host_ghz = calibrate_tsc_ghz();
    std::cout << "[main] Calibrated Host TSC Frequency: " << host_ghz << " GHz\n";

    // Cold-path export ring buffer: ~340 bytes/slot * 65536 slots =~ 22MB —
    // too big for a thread stack (same reasoning as OrderBook below), so it's
    // heap-allocated once here and never touched again except through push()/pop().
    // Single producer (consumer_thread, below) / single consumer (ColdPathExporter's
    // own drain thread) — SPSC contract, same as the Tick queues above.
    auto export_ring = std::make_unique<ExportRingBuffer>();

    // LiveHistogram is updated only by the drain thread inside ColdPathExporter
    // (never the trading/gateway thread) and is owned here, independently of
    // ColdPathExporter, so any future consumer (e.g. a relay/web layer) can
    // hold the same reference without this file changing. TerminalProgressView
    // is just today's consumer — it only calls histogram.snapshot().
    LiveHistogram live_histogram;

    // Live push to the relay's /ingest — see relay_push_client.hpp. Two ways
    // to configure it, flags winning when both are given:
    //   --relay-url <ws://host:port|host:port>, --relay-token <token>
    //     Interactive/dev-loop convenience — argv, not env.
    //   RELAY_WS_HOST / RELAY_WS_PORT / INGEST_TOKEN
    //     What a systemd unit's Environment= lines want (matches how
    //     relay/README.md configures the relay itself the same way), and
    //     still what relay/scripts/rotate-live-capture.sh uses to point the
    //     same binary at a different relay/port per instrument.
    // If NEITHER says anything about the relay at all, RelayPushClient is
    // not constructed. Defaulting to localhost:8080 when nothing was
    // configured used to be this function's behavior -- a silent wrong
    // guess (nobody runs the gateway locally with a relay happening to
    // listen on that exact port), not a sensible fallback. "Omitted" now
    // actually means "no relay client", not "guess localhost".
    auto env_or = [](const char* name, const std::string& fallback) -> std::string {
        const char* v = std::getenv(name);
        return v ? std::string(v) : fallback;
    };

    std::string relay_url_flag;
    std::string relay_token_flag;
    for (int i = 3; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--relay-url" && i + 1 < argc) {
            relay_url_flag = argv[++i];
        } else if (arg == "--relay-token" && i + 1 < argc) {
            relay_token_flag = argv[++i];
        }
    }

    // Accepts a bare "host:port" or "ws://host:port[/path]" (scheme and any
    // trailing path stripped) so pasting the same address style this project
    // already uses elsewhere for relay URLs just works.
    auto parse_relay_url = [](const std::string& url) -> std::pair<std::string, std::string> {
        std::string s = url;
        auto scheme_pos = s.find("://");
        if (scheme_pos != std::string::npos) s = s.substr(scheme_pos + 3);
        auto slash_pos = s.find('/');
        if (slash_pos != std::string::npos) s = s.substr(0, slash_pos);
        auto colon_pos = s.rfind(':');
        if (colon_pos == std::string::npos) return {s, "8080"};
        return {s.substr(0, colon_pos), s.substr(colon_pos + 1)};
    };

    const char* env_relay_host = std::getenv("RELAY_WS_HOST");
    const char* env_relay_port = std::getenv("RELAY_WS_PORT");
    const bool relay_configured = !relay_url_flag.empty() || env_relay_host || env_relay_port;

    std::unique_ptr<RelayPushClient> relay_push;
    if (relay_configured) {
        std::string relay_host, relay_port;
        if (!relay_url_flag.empty()) {
            std::tie(relay_host, relay_port) = parse_relay_url(relay_url_flag);
        } else {
            relay_host = env_or("RELAY_WS_HOST", "localhost");
            relay_port = env_or("RELAY_WS_PORT", "8080");
        }

        std::optional<std::string> relay_token;
        if (!relay_token_flag.empty()) relay_token = relay_token_flag;
        else if (const char* t = std::getenv("INGEST_TOKEN")) relay_token = std::string(t);

        // Heap-allocated, not a main()-stack local: RelayPushClient's internal
        // ring buffer is ~6.6MB (see relay_push_client.hpp), the same "too big
        // for a stack" reasoning export_ring above and OrderBook elsewhere in
        // this codebase already follow. A stack-local version of this crashed
        // with STATUS_STACK_OVERFLOW immediately on startup — confirmed, not
        // theoretical.
        relay_push = std::make_unique<RelayPushClient>(relay_host, relay_port, host_ghz, relay_token);
        std::cout << "[main] relay push -> ws://" << relay_host << ":" << relay_port << "/ingest\n";
    } else {
        std::cout << "[main] relay push disabled (no --relay-url/--relay-token or "
                     "RELAY_WS_HOST/RELAY_WS_PORT/INGEST_TOKEN set)\n";
    }

    ColdPathExporter exporter(*export_ring, host_ghz, live_histogram, "data/export",
        relay_push ? std::function<void(const ExportRecord&)>(
                         [rp = relay_push.get()](const ExportRecord& rec) { rp->push(rec); })
                   : nullptr);
    TerminalProgressView progress_view(live_histogram);

    // Spawn threads. Pinning happens inside each lambda via pin_thread_self()
    // rather than externally via pin_thread() after spawn.
    // WHY internal pinning on Windows:
    // External pinning requires converting a pthread_t to a Win32 HANDLE.
    // MinGW's winpthreads does not expose pthread_getw32threadhandle_np(),
    // making that conversion unreliable (produces INVALID_HANDLE_VALUE or
    // a stale handle, causing SetThreadAffinityMask to fail with err=6).
    // GetCurrentThread() called from inside the thread always returns a valid
    // pseudo-handle for the calling thread — no conversion needed, no ambiguity.
    // On Linux, pin_thread_self() uses pthread_self() + pthread_setaffinity_np(),
    // which is equivalent to the external approach and equally correct.
    // The cost: the first few instructions of each thread run unpinned while
    // the OS schedules them on an arbitrary core. pin_thread_self() corrects
    // this immediately. The steady-state hot path (read loop / consume loop)
    // runs pinned — which is all that matters for latency measurement.

    // WS thread: connect, read, parse, push to queue
    std::thread ws_depth_thread([&]() {
        // Self-configure for high performance
        configure_self_high_performance(CORE_PRODUCER, "ws_depth_thread");
        try {
            auto client = make_market_data_source(source_cfg, depth_queue, g_stop, latency_, last_u, queue_overflow_dropped);
            client->run(Channel::Depth);
        } catch (const std::exception& e) {
            std::cerr << "[ws_depth_thread] fatal: " << e.what() << "\n";

            // If the websocket dies, set the stop flag so other threads shut down cleanly;
            // default seq_cst is fine here since this runs only on fatal errors.
            g_stop.store(true);
        }
    });

    std::thread ws_trade_thread([&]() {
        // Self-configure for high performance
        configure_self_high_performance(CORE_PRODUCER, "ws_trade_thread");
        try {
            auto client = make_market_data_source(source_cfg, trade_queue, g_stop, latency_, last_u, queue_overflow_dropped);
            client->run(Channel::Trades);
        } catch (const std::exception& e) {
            std::cerr << "[ws_trade_thread] fatal: " << e.what() << "\n";
            g_stop.store(true);
        }
    });

    // Coarse-book threads: same Hyperliquid connection machinery as the real
    // depth/trades threads, but display-only channels that never touch
    // depth_queue/trade_queue/latency_/the OrderBook — see
    // Channel::CoarseDepth's own comment. Not latency-critical (they feed a
    // UI dropdown tier, not the trading path), so kept off the hot cores at
    // normal priority, same convention as export_drain/relay_push. One
    // thread per tier in COARSE_TIERS — see coarse_book_state.hpp for why a
    // single tier could not serve every bucket size.
    std::vector<std::thread> ws_coarse_threads;
    for (size_t i = 0; i < COARSE_TIER_COUNT; ++i) {
        ws_coarse_threads.emplace_back([&, i]() {
            const std::string thread_name = "ws_coarse_thread_" + std::to_string(coarse_tiers[i].nsigfigs);
            pin_thread_off_hot_cores(thread_name);
            try {
                HyperliquidAdapter coarse_client(coarse_unused_queue, g_stop, coarse_unused_latency, last_u,
                                                  queue_overflow_dropped, symbol, &coarse_tiers[i].state,
                                                  coarse_tiers[i].nsigfigs);
                coarse_client.run(Channel::CoarseDepth);
            } catch (const std::exception& e) {
                // Deliberately does NOT set g_stop — this channel is best-effort
                // display enrichment, not required for the real pipeline to run
                // (matching RelayPushClient's own "a relay/side channel being
                // down is not fatal here" philosophy).
                std::cerr << "[" << thread_name << "] fatal: " << e.what() << "\n";
            }
        });
    }

    // Consumer thread: pop from queue, update book, write CSV
    std::thread consumer_thread([&]() {
        // Self-configure for high performance
        configure_self_high_performance(CORE_CONSUMER, "consumer_thread");
        try {
            consumer_loop(depth_queue, trade_queue, g_stop, latency_, mmap_writer, last_u, exporter, queue_overflow_dropped, coarse_tiers);
        } catch (const std::exception& e) {
            std::cerr << "[consumer_thread] fatal: " << e.what() << "\n";
            g_stop.store(true);
        }
    });

    // Timer: stop after run_minutes or on signal
    auto t_end = std::chrono::steady_clock::now() +
                 std::chrono::minutes(run_minutes);
    while (!g_stop.load() &&
           std::chrono::steady_clock::now() < t_end) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
    if (!g_stop.load()) {
        std::cout << "[main] " << run_minutes << " min elapsed — stopping\n";
        g_stop.store(true);
    }

    ws_depth_thread.join();
    ws_trade_thread.join();
    for (auto& t : ws_coarse_threads) t.join();
    consumer_thread.join();

    // Teardown: After threads are dead, we have sole access to the data.
    // Let the user know the consumer loop is fully closed.
    std::cout << "[main] Threads joined. Syncing to disk...\n";

    // Note: The destructor of our MmapWriter automatically unmaps and flushes to disk.
    // If you explicitly implemented close_and_sync() and tick_count() in your class, you can call them.
    // Otherwise, the program safely flushes everything right here as variables go out of scope.

    // dump() function for your LatencyStore to save it to CSV, call it here:
    latency_.dump("data/latency.csv", host_ghz); // Pass the calibrated GHz for accurate conversion

    // Final output matching the image structure
    std::cout << "[main] ticks written: " << mmap_writer.tick_count() << "\n" // Assumes you added this helper method
              << "[main] binary file:   data/ticks.bin\n"
              << "[main] clean exit.\n";

    return 0;
}