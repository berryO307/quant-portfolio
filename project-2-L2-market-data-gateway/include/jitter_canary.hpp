#pragma once
#include "rdtsc.hpp"
#include "thread_utils.hpp"
#include <atomic>
#include <thread>
#include <chrono>
#include <cstdint>

// Jitter canary: a thread with no purpose other than measuring host
// scheduling noise. It sleeps for a fixed interval in a loop and records how
// far the ACTUAL wake time missed the INTENDED one, using rdtscp for timing
// (consistent with the rest of this codebase's latency measurement — see
// rdtsc.hpp). The most recent reading is exposed as host_jitter_ns context
// on export samples: a rough, independent proxy for "how noisy was the host
// around this tick", regardless of what this process's own hot path is
// doing at the time.
//
// WSL2 NOTE: isolcpus-style core isolation only applies to WSL2's *virtual*
// CPUs, not the physical cores the Windows host actually schedules onto.
// Under WSL2, this canary can still be preempted by host-level activity
// (Windows scheduler, hypervisor, other VMs/processes) that no amount of
// in-guest core pinning can hide from. That is the exact class of noise this
// canary exists to surface, not paper over — a nonzero jitter reading here
// does not mean the isolation setup is broken, it means the isolation
// genuinely cannot reach that layer on this platform. On bare metal /
// isolcpus-capable Linux, pinning this thread away from the hot-path cores
// is expected to actually eliminate cross-thread contention as a jitter
// source, leaving mostly interrupt/hypervisor-level noise visible.
//
// WINDOWS/MinGW NOTE: plain std::this_thread::sleep_for() cannot resolve
// waits at 100us scale on this platform — measured empirically, a bare
// sleep_for(100us) here returned in ~20ns, i.e. it did not actually sleep at
// all (Windows' default timer granularity, and/or this libstdc++'s duration
// handling, rounds sub-millisecond sleep_for calls down to a near-instant
// return). A canary built on that alone would read a constant ~-100000ns on
// every sample instead of a real, varying signal. So run() below only uses
// sleep_for for the coarse portion of the interval (a no-op on platforms
// that can't honor it) and busy-spins the last kSpinTailNs via rdtscp to hit
// the target precisely — this is what makes a sub-millisecond canary
// meaningful cross-platform, not a workaround being hidden: the spin is
// pinned to this thread's own dedicated core and never touches the hot path.
class JitterCanary {
public:
    // core_id must differ from any hot-path core (see main.cpp's
    // CORE_PRODUCER/CORE_CONSUMER) and from the Phase 3 histogram/export
    // threads' cores, if those are ever pinned too.
    // cpu_ghz: calibrated TSC frequency (calibrate_tsc_ghz()), used only to
    // convert the measured cycle delta into nanoseconds.
    JitterCanary(int core_id, double cpu_ghz,
                 std::chrono::microseconds interval = std::chrono::microseconds(100))
        : core_id_(core_id), cpu_ghz_(cpu_ghz), interval_(interval), running_(true) {
        thread_ = std::thread([this]() { run(); });
    }

    ~JitterCanary() {
        running_.store(false, std::memory_order_release);
        if (thread_.joinable()) thread_.join();
    }

    JitterCanary(const JitterCanary&)            = delete;
    JitterCanary& operator=(const JitterCanary&) = delete;

    // Safe to call from any thread, at any time. Overshoot (actual - intended
    // wake time, in ns) from the canary's most recently completed cycle.
    // Always >= 0 by construction — see run(): the spin tail waits until AT
    // LEAST the intended interval has elapsed, so it can only measure how
    // much longer than intended the wake took, never "early".
    int64_t jitter_ns() const { return last_jitter_ns_.load(std::memory_order_relaxed); }

private:
    // Reserved for the precise rdtscp busy-spin tail (see WINDOWS/MinGW note
    // above). If the interval is shorter than this, the whole thing spins.
    static constexpr int64_t kSpinTailNs = 50'000;   // 50us

    void run() {
        // One-time setup only — pinning (and its one console print) happens
        // here, never inside the loop below.
        pin_thread_self(core_id_, "jitter_canary");

        const int64_t intended_ns =
            std::chrono::duration_cast<std::chrono::nanoseconds>(interval_).count();
        const int64_t coarse_ns = (intended_ns > kSpinTailNs) ? (intended_ns - kSpinTailNs) : 0;

        // Loop body: no allocation, no logging, no I/O — just rdtscp, an
        // optional coarse sleep, an rdtscp-driven spin, and a relaxed atomic
        // store.
        while (running_.load(std::memory_order_relaxed)) {
            uint64_t t0 = rdtscp();

            if (coarse_ns > 0) {
                std::this_thread::sleep_for(std::chrono::nanoseconds(coarse_ns));
            }

            // Precise tail: spin until at least intended_ns has elapsed since
            // t0. Any time spent here beyond intended_ns — e.g. this thread
            // getting involuntarily preempted mid-spin — IS host jitter.
            uint64_t t1;
            double   actual_ns;
            do {
                t1 = rdtscp();
                actual_ns = tsc_to_ns(t1 - t0, cpu_ghz_);
            } while (actual_ns < static_cast<double>(intended_ns));

            int64_t jitter_ns = static_cast<int64_t>(actual_ns) - intended_ns;
            last_jitter_ns_.store(jitter_ns, std::memory_order_relaxed);
        }
    }

    int                        core_id_;
    double                     cpu_ghz_;
    std::chrono::microseconds interval_;
    std::atomic<bool>          running_;
    std::atomic<int64_t>       last_jitter_ns_{0};
    std::thread                thread_;
};
