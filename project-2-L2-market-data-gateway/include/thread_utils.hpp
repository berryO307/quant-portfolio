#pragma once
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

// Core assignments for the latency-critical path. Defined here rather than
// as locals in main() because the COLD-path threads also need to know them —
// not to run on them, but to stay OFF them (see pin_thread_off_hot_cores).
//
// Pinning the hot-path threads only constrains where THOSE threads run. It
// does nothing to stop this process's own background threads
// (ColdPathExporter's gzip/file-I/O drain, RelayPushClient's Asio loop,
// TerminalProgressView's console writes) from being scheduled onto the very
// same cores, because none of them set an affinity at all.
//
// WHY THESE ARE RUNTIME VALUES AND NOT constexpr 2/3/4
// ----------------------------------------------------
// They used to be compile-time constants, which meant EVERY instance of this
// gateway pinned to the same three cores. Running two instruments (one
// process each, which is the normal deployment here) put two TIME_CRITICAL
// consumer threads on the same core, both busy-spinning on their ring
// buffer. Neither yields, so the OS time-slices between them at the Windows
// scheduler quantum — and a tick pushed while the OTHER instance held the
// core sat in the ring for that entire quantum.
//
// Measured, one instrument vs two, same binary, same 2-minute methodology:
//   two instances sharing cores: queue-wait p99 = 15.4ms, 33.9% of samples >1ms
//   one instance alone:          queue-wait p99 = 58us,   0.00% of samples >1ms
// a 265x difference at p99, entirely from core contention between instances.
//
// So each process now claims its own disjoint core triple at startup (see
// configure_hot_cores), rather than trusting the operator to pass
// non-overlapping values.
struct HotCores {
    int producer = 2;
    int consumer = 3;
    // Every logical CPU belonging to the claimed PHYSICAL core (producer and
    // consumer's SMT sibling pair). Cold-path threads are steered off both,
    // not just off producer/consumer individually — an SMT sibling running
    // the gzip drain steals execution units from the spinning consumer
    // beside it just as effectively as sharing the logical CPU would.
    std::vector<int> reserved{2, 3};
};

// Process-wide, written once by configure_hot_cores() before any thread is
// spawned and read-only thereafter.
inline HotCores& hot_cores() {
    static HotCores cores;
    return cores;
}

#ifdef _WIN32
    #include <windows.h>
#else
    #include <pthread.h>
    #include <sched.h>
    #include <fcntl.h>
    #include <sys/file.h>
    #include <unistd.h>
#endif

// pin_thread_self()
// Called from INSIDE the thread that wants to be pinned.
// Uses GetCurrentThread() on Windows — always returns a valid pseudo-handle
// for the calling thread, no pthread→HANDLE conversion required.
// This avoids the winpthreads limitation where pthread_getw32threadhandle_np
// is not available (that function only exists in the older pthreads-win32 lib).
// On Linux, uses pthread_setaffinity_np on the calling thread's handle.

// Internal configuration: Thread sets its own affinity and priority
inline void configure_self_high_performance(int core_id, const std::string& name) {
    std::cout << "[thread] Configuring " << name << " on Core " << core_id << "...\n";
#ifdef _WIN32
    // 1. Set Affinity for the calling thread
    HANDLE hThread = GetCurrentThread();
    DWORD_PTR mask = (static_cast<DWORD_PTR>(1) << core_id);
    if (!SetThreadAffinityMask(hThread, mask)) {
        std::cerr << "   [!] Failed Affinity. Error: " << GetLastError() << "\n";
    }

    // 2. Set Priority to Time Critical
    if (!SetThreadPriority(hThread, THREAD_PRIORITY_TIME_CRITICAL)) {
        std::cerr << "   [!] Failed Priority. Error: " << GetLastError() << "\n";
    }
#else
    // Linux Implementation
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);
    pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);

    // SCHED_FIFO requires CAP_SYS_NICE — an unprivileged caller gets EPERM
    // (pthread_setschedparam returns the errno value directly, doesn't set
    // the global errno) and this thread silently stays on the default
    // SCHED_OTHER. Previously unchecked. Re-queried via
    // pthread_getschedparam rather than trusting a non-EPERM return alone,
    // same "confirm what was achieved" discipline as main()'s process-level
    // check.
    sched_param sch_params{};
    sch_params.sched_priority = sched_get_priority_max(SCHED_FIFO);
    int rc = pthread_setschedparam(pthread_self(), SCHED_FIFO, &sch_params);
    if (rc != 0) {
        std::cerr << "   [!] pthread_setschedparam(SCHED_FIFO) failed for '" << name
                  << "': " << std::strerror(rc) << " (rc=" << rc << "). Requires "
                     "CAP_SYS_NICE — run with sudo, or: sudo setcap cap_sys_nice=eip <binary>.\n";
    }
    int achieved_policy = 0;
    sched_param achieved_param{};
    pthread_getschedparam(pthread_self(), &achieved_policy, &achieved_param);
    if (achieved_policy != SCHED_FIFO) {
        std::cerr << "   [!] '" << name << "' requested SCHED_FIFO but is actually running "
                     "under policy=" << achieved_policy << " (SCHED_OTHER=" << SCHED_OTHER
                  << ") — real-time scheduling was not granted.\n";
    }
#endif
}

// Claims a core triple for this process, so two instances never share one.
//
// Tries base, base+3, base+6, ... and takes the first triple no other
// instance already holds, using a named OS object as the claim (a named
// mutex on Windows, an O_EXCL lock file on POSIX). The claim is held for the
// life of the process deliberately — it is released when the process exits,
// which is exactly the lifetime the reservation should have.
//
// GATEWAY_CORE_BASE overrides the starting point for anyone who wants to
// place instances by hand; the collision check still applies on top of it,
// so an explicit value that is already taken still moves rather than
// silently double-booking a core.
//
// Falls back to the default triple with a loud warning if every candidate is
// taken or the machine is too small — degraded, but running and visibly so,
// rather than refusing to start.
// Takes a cross-process claim on ONE physical core. Named mutex on Windows,
// O_EXCL + flock lock file on POSIX; both are released by the OS on process
// exit, which is exactly the lifetime the reservation should have.
inline bool try_claim_one_physical(int idx) {
#ifdef _WIN32
    const std::string claim = "Local\\L2DataCapture_phys_" + std::to_string(idx);
    HANDLE h = CreateMutexA(nullptr, TRUE, claim.c_str());
    if (h && GetLastError() != ERROR_ALREADY_EXISTS) return true;  // handle intentionally leaked
    if (h) CloseHandle(h);
    return false;
#else
    const std::string claim = "/tmp/l2datacapture_phys_" + std::to_string(idx) + ".lock";
    int fd = ::open(claim.c_str(), O_CREAT | O_RDWR, 0644);
    if (fd < 0) return false;
    // flock, not just O_EXCL: O_EXCL leaves the file behind after a hard kill,
    // so a stale file with no live holder must still be reusable.
    if (::flock(fd, LOCK_EX | LOCK_NB) == 0) return true;  // fd intentionally left open
    ::close(fd);
    return false;
#endif
}

// One physical core and the logical CPUs (SMT siblings) that live on it.
struct PhysicalCore {
    std::vector<int> logical;
};

// Real topology, from the OS. Falls back to "every logical CPU is its own
// physical core" if the query fails, which degrades to the old behaviour
// rather than guessing a sibling layout.
//
// Guessing is exactly what the previous version did implicitly by handing out
// logical N, N+1 as if they were independent. On the machine this was
// developed on (Ryzen 5 3600X, 6 physical / 12 logical, SMT on) the real map is
// sequential pairs — physical 1 = logical 2,3 — and NOT knowing that put two
// instances' consumers on the same physical core when they were handed
// logical values that only looked disjoint.
inline std::vector<PhysicalCore> enumerate_physical_cores() {
    std::vector<PhysicalCore> cores;
#ifdef _WIN32
    DWORD len = 0;
    GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &len);
    if (len == 0) return cores;
    std::vector<char> buf(len);
    if (!GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(buf.data()), &len)) {
        return cores;
    }
    char* cur = buf.data();
    char* end = buf.data() + len;
    while (cur < end) {
        auto* e = reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(cur);
        if (e->Relationship == RelationProcessorCore) {
            PhysicalCore pc;
            for (WORD g = 0; g < e->Processor.GroupCount; ++g) {
                KAFFINITY m = e->Processor.GroupMask[g].Mask;
                for (int b = 0; b < 64; ++b) {
                    if (m & (static_cast<KAFFINITY>(1) << b)) pc.logical.push_back(b);
                }
            }
            if (!pc.logical.empty()) cores.push_back(std::move(pc));
        }
        cur += e->Size;
    }
#else
    // /sys/.../topology/thread_siblings_list gives this CPU's siblings, e.g.
    // "0,6" or "0-1". Dedup by the lowest sibling id so each physical core is
    // recorded once.
    const unsigned hw = std::thread::hardware_concurrency();
    std::vector<bool> seen(hw, false);
    for (unsigned c = 0; c < hw; ++c) {
        if (seen[c]) continue;
        const std::string path = "/sys/devices/system/cpu/cpu" + std::to_string(c) +
                                 "/topology/thread_siblings_list";
        std::ifstream f(path);
        PhysicalCore pc;
        std::string spec;
        if (f && std::getline(f, spec)) {
            size_t i = 0;
            while (i < spec.size()) {
                size_t j = spec.find_first_of(",", i);
                std::string tok = spec.substr(i, j == std::string::npos ? j : j - i);
                size_t dash = tok.find('-');
                if (dash == std::string::npos) {
                    pc.logical.push_back(std::atoi(tok.c_str()));
                } else {
                    const int lo = std::atoi(tok.substr(0, dash).c_str());
                    const int hi = std::atoi(tok.substr(dash + 1).c_str());
                    for (int k = lo; k <= hi; ++k) pc.logical.push_back(k);
                }
                if (j == std::string::npos) break;
                i = j + 1;
            }
        }
        if (pc.logical.empty()) pc.logical.push_back(static_cast<int>(c));
        for (int l : pc.logical) {
            if (l >= 0 && l < static_cast<int>(hw)) seen[l] = true;
        }
        cores.push_back(std::move(pc));
    }
#endif
    return cores;
}

// Claims ONE PHYSICAL core for this process, so two instances never share
// one and neither shares one with itself:
//   consumer -> logical 0 on the claimed physical core (busy-spins; needs the core)
//   producer -> logical 1, the SMT sibling
//
// Putting the producer on the consumer's SMT sibling is deliberate rather than
// a compromise. Both websocket threads block in a socket read, so they are not
// runnable most of the time and steal nothing from the spinning consumer; when
// they do wake, it is precisely to hand a tick across the ring to that consumer,
// and sharing L1/L2 makes that handoff cheaper. Two SPINNING threads on one
// physical core is the thing to avoid, not two threads.
//
// This used to claim a physical-core PAIR — a second core, its sibling left
// deliberately idle, existed solely to give a host-noise-measuring canary
// thread an isolated core (see git history if that measurement is ever
// needed again). Removed along with the canary itself: this project measures
// its own hot-path work, not ambient host scheduler noise, so there is
// nothing left needing an isolated core, and claiming only one halves the
// per-instance core footprint — twice as many instrument instances now fit
// on the same machine.
//
// GATEWAY_CORE_BASE selects the starting PHYSICAL core index. The collision
// check still applies on top, so an explicit-but-taken value moves rather than
// silently double-booking.
inline void configure_hot_cores() {
    const unsigned hw = std::thread::hardware_concurrency();
    std::vector<PhysicalCore> cores = enumerate_physical_cores();

    if (cores.empty()) {
        std::cerr << "[cores] WARNING: could not read CPU topology — falling back to "
                     "treating every logical CPU as its own physical core. On an SMT "
                     "machine this may co-locate two spinning threads.\n";
        for (unsigned c = 0; c < hw; ++c) cores.push_back(PhysicalCore{{static_cast<int>(c)}});
    }

    int base = 1;   // physical 0 left to the OS and this process's cold path
    if (const char* env = std::getenv("GATEWAY_CORE_BASE")) {
        const int parsed = std::atoi(env);
        if (parsed >= 0) base = parsed;
    }

    const int n = static_cast<int>(cores.size());
    for (int p = base; p < n; ++p) {
        if (!try_claim_one_physical(p)) continue;

        const PhysicalCore& hot = cores[p];
        HotCores hc;
        hc.consumer = hot.logical[0];
        hc.producer = hot.logical.size() > 1 ? hot.logical[1] : hot.logical[0];
        hc.reserved.clear();
        for (int l : hot.logical) hc.reserved.push_back(l);
        hot_cores() = hc;

        std::cout << "[cores] claimed physical " << p
                  << " -> consumer=" << hc.consumer
                  << " producer=" << hc.producer
                  << " (reserved logical:";
        for (int l : hc.reserved) std::cout << " " << l;
        std::cout << ")\n";
        return;
    }

    std::cerr << "[cores] WARNING: no free physical core from base " << base
              << " on a " << n << "-physical/" << hw << "-logical machine — falling back to "
              << hot_cores().producer << "/" << hot_cores().consumer << ". Another instance "
                 "may already hold these, in which case both will time-slice against each "
                 "other and queue-wait will show multi-millisecond spikes.\n";
}

// Called from INSIDE a COLD-path thread (export drain, relay push, progress
// view). The inverse of pin_thread_self: instead of binding to one core, it
// removes the hot-path core's logical CPUs from this thread's affinity mask
// so the OS can run it anywhere except where the consumer/producer spin.
//
// Why this is needed at all: the export drain does zlib deflate plus
// periodic blocking file writes — exactly the kind of work that can hold a
// core long enough to delay the TIME_CRITICAL consumer if the OS ever
// schedules the two together on the same core. Best-effort: on a machine
// with too few cores to spare, the mask would be empty, so it falls back to
// leaving affinity untouched rather than pinning a thread to nothing.
inline void pin_thread_off_hot_cores(const std::string& name = "") {
    const unsigned hw = std::thread::hardware_concurrency();
    if (hw == 0 || hw <= 4) {
        std::cout << "[pin] '" << name << "': only " << hw
                  << " logical cores — leaving cold-path affinity unrestricted\n";
        return;
    }

#ifdef _WIN32
    const HotCores& hc = hot_cores();
    DWORD_PTR mask = 0;
    for (int c = 0; c < static_cast<int>(hw) && c < static_cast<int>(sizeof(DWORD_PTR) * 8); ++c) {
        if (std::find(hc.reserved.begin(), hc.reserved.end(), c) != hc.reserved.end()) continue;
        mask |= (static_cast<DWORD_PTR>(1) << c);
    }
    if (mask == 0) return;
    if (SetThreadAffinityMask(GetCurrentThread(), mask) == 0) {
        std::cerr << "[pin] WARNING: could not restrict cold-path thread '" << name
                  << "' off the hot cores (err=" << GetLastError() << ")\n";
        return;
    }
    std::cout << "[pin] '" << name << "' kept off hot cores "
              << hc.producer << "/" << hc.consumer
              << " (mask=0x" << std::hex << mask << std::dec << ")\n";
#else
    const HotCores& hc = hot_cores();
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    for (int c = 0; c < static_cast<int>(hw) && c < CPU_SETSIZE; ++c) {
        if (std::find(hc.reserved.begin(), hc.reserved.end(), c) != hc.reserved.end()) continue;
        CPU_SET(c, &cpuset);
    }
    int rc = pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
    if (rc != 0) {
        std::cerr << "[pin] WARNING: could not restrict cold-path thread '" << name
                  << "' off the hot cores (rc=" << rc << ")\n";
        return;
    }
    std::cout << "[pin] '" << name << "' kept off hot cores "
              << hc.producer << "/" << hc.consumer << "\n";
#endif
}

inline void pin_thread_self(int core_id, const std::string& name = "") {
#ifdef _WIN32
    HANDLE self = GetCurrentThread();   // always valid — no conversion needed

    DWORD_PTR mask      = 1ULL << core_id;
    DWORD_PTR prev_mask = SetThreadAffinityMask(self, mask);

    if (prev_mask == 0) {
        std::cerr << "[pin] WARNING: SetThreadAffinityMask failed for '"
                  << name << "' on core " << core_id
                  << " (err=" << GetLastError() << ") — thread will float freely\n";
        return;
    }

    std::cout << "[pin] '" << name << "' pinned to core " << core_id
              << " (prev_mask=0x" << std::hex << prev_mask << std::dec << ")\n";

#else
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);

    int rc = pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
    if (rc != 0) {
        std::cerr << "[pin] WARNING: pthread_setaffinity_np failed for '"
                  << name << "' on core " << core_id
                  << " (rc=" << rc << ") — thread will float freely\n";
        return;
    }
    std::cout << "[pin] '" << name << "' pinned to core " << core_id << "\n";
#endif
}

// verify_pin_self()
// Called from INSIDE the thread to verify it's running on the expected core.
// On Windows: reads current affinity via SetThreadAffinityMask read-then-restore idiom
//             (there is no GetThreadAffinityMask for a single thread in Win32).
// On Linux:   reads via pthread_getaffinity_np.

inline void verify_pin_self(int expected_core, const std::string& name = "") {
#ifdef _WIN32
    HANDLE self = GetCurrentThread();

    DWORD_PTR expected_mask = 1ULL << expected_core;

    // Read-then-restore: SetThreadAffinityMask returns the previous mask on success.
    // Set to expected, capture old, restore old. Standard Win32 idiom for reading affinity.
    DWORD_PTR actual_mask = SetThreadAffinityMask(self, expected_mask);
    if (actual_mask == 0) {
        std::cerr << "[pin] WARNING: verify_pin_self read failed for '"
                  << name << "' (err=" << GetLastError() << ")\n";
        return;
    }
    SetThreadAffinityMask(self, actual_mask);   // restore original

    if (actual_mask == expected_mask) {
        std::cout << "[pin] verified '" << name << "' on core " << expected_core << "\n";
    } else {
        std::cerr << "[pin] WARNING: '" << name << "' expected mask=0x"
                  << std::hex << expected_mask
                  << " actual mask=0x" << actual_mask << std::dec
                  << " — OS may have overridden affinity\n";
    }

#else
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    int rc = pthread_getaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
    if (rc != 0) {
        std::cerr << "[pin] WARNING: pthread_getaffinity_np failed for '" << name << "'\n";
        return;
    }
    if (!CPU_ISSET(expected_core, &cpuset)) {
        std::cerr << "[pin] WARNING: '" << name << "' is NOT on core "
                  << expected_core << " — affinity may have been overridden\n";
    } else {
        std::cout << "[pin] verified '" << name << "' on core " << expected_core << "\n";
    }
#endif
}

// Legacy external-pinning wrappers (kept for API compatibility).
// These work on Linux but on Windows/winpthreads the pthread_t→HANDLE
// conversion is unreliable. Use pin_thread_self() from inside the thread instead.

inline void pin_thread(std::thread& t, int core_id, const std::string& name = "") {
#ifdef _WIN32
    // External pinning is unreliable on winpthreads — delegate to self-pin.
    // This is a no-op here; the thread must call pin_thread_self() internally.
    (void)t; (void)core_id;
    std::cout << "[pin] '" << name << "': external pin skipped on Windows"
              << " — thread calls pin_thread_self() internally\n";
#else
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);
    int rc = pthread_setaffinity_np(t.native_handle(), sizeof(cpu_set_t), &cpuset);
    if (rc != 0) {
        std::cerr << "[pin] WARNING: pthread_setaffinity_np failed for '"
                  << name << "' on core " << core_id
                  << " (rc=" << rc << ") — thread will float freely\n";
        return;
    }
    std::cout << "[pin] '" << name << "' pinned to core " << core_id << "\n";
#endif
}

inline void verify_pin(std::thread& t, int expected_core, const std::string& name = "") {
#ifdef _WIN32
    (void)t;
    (void)expected_core;
    std::cout << "[pin] '" << name << "': external verify skipped on Windows"
              << " — thread verifies itself via verify_pin_self()\n";
#else
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    int rc = pthread_getaffinity_np(t.native_handle(), sizeof(cpu_set_t), &cpuset);
    if (rc != 0) {
        std::cerr << "[pin] WARNING: pthread_getaffinity_np failed for '" << name << "'\n";
        return;
    }
    if (!CPU_ISSET(expected_core, &cpuset)) {
        std::cerr << "[pin] WARNING: '" << name << "' is NOT on core " << expected_core << "\n";
    } else {
        std::cout << "[pin] verified '" << name << "' on core " << expected_core << "\n";
    }
#endif
}