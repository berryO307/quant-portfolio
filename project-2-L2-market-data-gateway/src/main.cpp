#include "types.hpp"
#include "spsc_ring_buffer.hpp"
#include "order_book.hpp"
#include "rest_client.hpp"
#include "ws_client.hpp"
#include "mmap_writer.hpp"
#include "rdtsc.hpp"
#include "thread_utils.hpp"
#include "export_pipeline.hpp"

#include <atomic>
#include <chrono>
#include <csignal>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
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
                        ColdPathExporter& exporter) {

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

    // Declare the flag here so it persists across loop iterations
    bool just_resynced = true;

    // State machine for Binance L2 sync protocol
    enum class State { Init, Syncing, InSync };
    State state = State::Init;

    auto t_start    = std::chrono::steady_clock::now();
    auto t_last_log = t_start;
    auto t_last_export_snapshot = t_start;

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

    // Bybit's WS sends a "snapshot" type message immediately after subscribe.
    // Use that as the seed instead of REST — REST and WS sequence id spaces
    // are unrelated on Bybit, so REST cannot bootstrap a WS book.
    // rest_client.cpp is preserved for future use in hexagonal architecture
    // where each adapter will use its native exchange's bootstrap mechanism.
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
        // Bybit snapshot marker: pu==0 (set by parse_depth when type=="snapshot")
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
            }
            // Non-snapshot depth events before the snapshot are dropped — normal during init
        }
    }
    
    if (stop.load(std::memory_order_relaxed)) return;

    while (!stop.load(std::memory_order_relaxed)) {
        // FIX 2: Replaced blocking pop_for() (ThreadQueue condvar API) with non-blocking
        // SpscRingBuffer::pop() + microsecond sleep.
        //
        // WHY: SpscRingBuffer is intentionally lock-free — it has no condition variable
        // or mutex. pop_for() does not exist on it. The sleep_for avoids a busy-spin
        // (which would peg one CPU core at 100%) while accepting a ~100µs latency floor,
        // which is acceptable for a CSV data-collection tool (not a pure HFT execution core).
        // A dedicated-core HFT deployment would remove the sleep and pin this thread with
        // cpu_set_t, busy-spinning on pop() instead.
        Tick tick;
        bool got_tick = false;
        uint32_t queue_depth_at_pop = 0;   // source queue size, sampled right at pop — export context only
        if (depth_queue.pop(tick)) {
            got_tick = true;
            queue_depth_at_pop = static_cast<uint32_t>(depth_queue.size());
        } else if (trade_queue.pop(tick)) {
            got_tick = true;
            queue_depth_at_pop = static_cast<uint32_t>(trade_queue.size());
       }
        if (!got_tick) {
            std::this_thread::sleep_for(std::chrono::microseconds(100));
    continue;
        }

        uint64_t t3 = rdtscp();

        // Queue transit delta: needs t2 to be embedded in the Tick itself
        latency.queue_cycles.emplace_back(t3 - tick.t2_tsc);
        ++total_ticks;

        NormalizedTick out{};   // zero-initialise all fields
        SampleSide sample_side = SampleSide::NONE;   // export context only, set below
        // NOTE: NormalizedTick::stream_type is a SIGNED 1-bit field, so it can only
        // ever hold 0 or -1 — assigning 1 (below, pre-existing) silently stores -1.
        // Don't compare against it; track trade-ness separately for export purposes.
        bool is_trade_tick = false;

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

                // FUTURES GAP LOGIC: 'pu' MUST exactly match the book's current_last_u
                if (static_cast<uint64_t>(depth->pu) != current_last_u) {
                    ++gap_count;
                    std::cerr << "[consumer] GAP: expected pu=" << current_last_u
                              << " got pu=" << depth->pu << "\n";
                    goto RESYNC;
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
        latency.book_cycles.emplace_back(t4 - tick.t2_tsc);

        // Cold-path trade print: pushed into the export ring buffer, not written
        // synchronously here. Never blocks — see ColdPathExporter::push().
        if (is_trade_tick) {
            ExportRecord trade_rec{};
            trade_rec.type  = ExportRecordType::TRADE;
            trade_rec.trade = ExportTrade{ t4, out.price, out.qty, out.agg_trade_id, sample_side };
            exporter.push(trade_rec);
        }

        // Single memcpy into mmap — replaces the entire slow csv << string formatting chain
        mmap_writer.write(out);

        // Stage 4: publish complete (mmap write done).
        uint64_t t5 = rdtscp();
        latency.publish_cycles.emplace_back(t5 - t4);

        // Cold-path per-tick sample: the four stage timestamps plus context.
        // Pushed here (after t5), never blocks — see ColdPathExporter::push().
        {
            ExportRecord sample_rec{};
            sample_rec.type   = ExportRecordType::SAMPLE;
            sample_rec.sample = ExportSample{
                tick.t1_tsc, tick.t2_tsc, t4, t5,
                queue_depth_at_pop, sample_side,
                static_cast<uint8_t>(current_cpu_core())
            };
            exporter.push(sample_rec);
        }

        // Periodic L2 snapshot export (~1/s). Read-only against `book`, which this
        // thread already owns exclusively — no locking needed. Correlated with the
        // per-tick samples above via the same rdtscp clock.
        auto snap_now = std::chrono::steady_clock::now();
        if (snap_now - t_last_export_snapshot >= std::chrono::seconds(1)) {
            t_last_export_snapshot = snap_now;

            ExportRecord snap_rec{};
            snap_rec.type = ExportRecordType::SNAPSHOT;
            ExportSnapshot& snap = snap_rec.snapshot;
            snap.tsc       = rdtscp();
            snap.bid_count = book.top_bids(snap.bids, static_cast<int>(EXPORT_SNAPSHOT_DEPTH));
            snap.ask_count = book.top_asks(snap.asks, static_cast<int>(EXPORT_SNAPSHOT_DEPTH));
            exporter.push(snap_rec);
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
    // Requires Admin privileges. If not run as Admin, the OS will silently ignore the request and leave the process at normal priority, which may cause higher latency and more jitter.
    // On Linux, users can achieve similar results by running with sudo and using chrt to set SCHED_FIFO
    #ifdef _WIN32
    // Set the entire process to Realtime class
    if (!SetPriorityClass(GetCurrentProcess(), REALTIME_PRIORITY_CLASS)) {
        std::cerr << "Failed to set process priority class. Run as Admin.\n";
    }
    #endif

    // std::signal used intentionally for brevity; production POSIX code should use sigaction() because
    // signal() semantics are historically implementation-dependent and can introduce subtle races.
    std::signal(SIGINT,  signal_handler);
    std::signal(SIGTERM, signal_handler);

    // Core assignments — keep these at the top of main()
    // Revised Core Assignments for mechanical sympathy
    static constexpr int CORE_PRODUCER = 2; // Was CORE_WS_DEPTH/TRADE
    static constexpr int CORE_CONSUMER = 3; // Keep adjacent to Core 2

    // Default: run for 30 minutes unless overridden by argv[1]
    int run_minutes = 30;
    if (argc > 1) run_minutes = std::stoi(argv[1]);

    std::string symbol   = (argc > 2) ? argv[2] : "btcusdt";
    std::cout << "[main] L2DataCapture  symbol=" << symbol
              << "  run=" << run_minutes << "m\n";

    // FIX 3: Replaced ThreadQueue<Tick> with SpscRingBuffer<Tick, 1024>.
    // 1024 slots * sizeof(Tick) bytes each — tune capacity if your Tick struct grows large.
    // Capacity must remain a power of 2 (enforced by static_assert in SpscRingBuffer).
    // SPSC contract: exactly one producer (ws_thread) and one consumer (consumer_thread) —
    // never pass this queue to a second producer or consumer thread.
    // Two ring buffers — one per stream
    SpscRingBuffer<Tick, 1024> depth_queue;
    SpscRingBuffer<Tick, 1024> trade_queue;

    // Initiate the latency store here so it exists before the thread starts
    LatencyStore latency_;

    // Cold-path export ring buffer: ~340 bytes/slot * 65536 slots =~ 22MB —
    // too big for a thread stack (same reasoning as OrderBook below), so it's
    // heap-allocated once here and never touched again except through push()/pop().
    // Single producer (consumer_thread, below) / single consumer (ColdPathExporter's
    // own drain thread) — SPSC contract, same as the Tick queues above.
    auto export_ring = std::make_unique<ExportRingBuffer>();
    ColdPathExporter exporter(*export_ring);

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
            WsClient client(depth_queue, g_stop, latency_, last_u);
            client.run(symbol, "@depth@100ms");
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
            WsClient client(trade_queue, g_stop, latency_, last_u);
            client.run(symbol, "@aggTrade");
        } catch (const std::exception& e) {
            std::cerr << "[ws_trade_thread] fatal: " << e.what() << "\n";
            g_stop.store(true);
        }
    });

    // Consumer thread: pop from queue, update book, write CSV
    std::thread consumer_thread([&]() {
        // Self-configure for high performance
        configure_self_high_performance(CORE_CONSUMER, "consumer_thread");
        try {
            consumer_loop(depth_queue, trade_queue, g_stop, latency_, mmap_writer, last_u, exporter);
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