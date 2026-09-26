# L2 Market Data Gateway

> A C++20 HFT-style ingestion pipeline for Level-2 crypto market data. Engineered around mechanical sympathy: lock-free SPSC transport, cache-line-aware data layout, memory-mapped persistence, and hardware-clock latency profiling.

**Headline result:** **p99 queue transit latency of 7.4 µs**, sustained across multi-hour live captures from Bybit Futures.

> The original target venue was Binance Futures; live ingest pivoted to Bybit due to geographic restrictions on the deployment IP. The architecture is exchange-agnostic — the recovery and sequence-gap logic was designed against Binance's `pu`/`u` semantics and adapted for Bybit's equivalent.

> **Venue-dependent, but no longer platform-limited.** The 7.4µs figure was measured against Bybit Futures, which has since been removed (this gateway is Hyperliquid-only now). Against Hyperliquid's much lower live rate (~3–13 ticks/sec) the consumer spends most cycles polling an empty queue, so the poll's own wake latency — not the SPSC ring's transit cost — dominates.
>
> Current live measurement on native Windows, both instruments running: **queue transit p50 = 3.8µs, p90 = 10.7µs, p99 = 28.5µs, max = 29.9µs, with 0% of samples above 1ms.**
>
> Earlier revisions of this README and `notes/Engineering_Notes.md` §8–§9 reported a 10–16ms queue-wait tail here and attributed it to the Windows scheduler quantum being an unfixable platform limit. That was wrong: every instance pinned to the same hard-coded cores, so running two instruments put two busy-spinning consumers on one core and they time-sliced against each other at exactly the quantum. Each process now claims a disjoint core triple at startup. See §10 for the correction and the before/after numbers.

---

## Architecture at a Glance

```
                           ┌─────────────────────────────┐
   Bybit WebSocket    ──►  │  Producer Thread (Core 2)   │
                           │  Boost.Beast → simdjson →   │
                           │  ALU-only ASCII-to-int      │
                           └──────────────┬──────────────┘
                                          │
                                          ▼  std::memory_order_release
                           ┌─────────────────────────────┐
                           │   SPSC Ring Buffer          │
                           │   Wait-free, 64B-aligned    │
                           │   No mutex, no syscall      │
                           └──────────────┬──────────────┘
                                          │
                                          ▼  std::memory_order_acquire
                           ┌─────────────────────────────┐
                           │  Consumer Thread (Core 3)   │
                           │  PriceLadder bitboard       │
                           │  __builtin_clzll: 2 cycles  │
                           └──────────────┬──────────────┘
                                          │
                                          ▼  64B struct, mlock'd pages
                           ┌─────────────────────────────┐
                           │  mmap_writer → NVMe         │
                           │  Zero-copy, kernel async    │
                           └─────────────────────────────┘
```

Two pinned threads, one lock-free queue between them, zero heap allocations in the hot path, zero blocking syscalls during steady state.

---

## Latency Profile

Measured across ~25,000 ticks of live Bybit Futures depth and trade data using `__rdtscp` hardware timing.

| Stage / Operation | p50 | p99 | p99.9 |
| --- | ---: | ---: | ---: |
| **Queue transit** (the SPSC ring) | **0.4 µs** | **7.4 µs** | 47.9 µs |
| Parse latency (WS read + simdjson + ALU parse) | 8.3 µs | 146.1 µs | 178.0 µs |
| Full pipeline end-to-end | 10.4 µs | 147.6 µs | 182.1 µs |

| Micro-operation | Latency |
| --- | --- |
| Best-bid / best-ask lookup, any spread | ~0.6 ns (2× `clzll`) |
| Tick apply (array write + 2 bitops) | ~2 ns |
| Flash-crash, 10,000 levels wiped — naive `O(N)` scan | ~10,000 ns |
| Flash-crash, 10,000 levels wiped — this design | ~0.6 ns (unchanged) |

The queue itself is institutional-grade — a 0.4 µs median and 7.4 µs p99 across a real-world stream is the headline engineering result. The wider tail at the full-pipeline level is dominated by parse latency, which is bounded by the cost of `simdjson` DOM construction and websocket message arrival jitter rather than by the architecture itself. The order-book mutation stage does not degrade under volatility — bitboard lookup is bounded at ~0.6 ns whether the market moves 1 tick or 19,999.

---

## Visual Analysis

Four interactive Plotly figures break down the system's behavior. The full analytical walkthrough lives in **[`analysis/notebooks/latency_analysis.ipynb`](analysis/notebooks/latency_analysis.ipynb)** — open it on GitHub for the static render or run it locally for the interactive version.

### 1. Latency by pipeline stage

![Latency by pipeline stage](analysis/output/latency_by_stage.png)

Decomposes total latency into parse vs. queue transit vs. full pipeline at p50, p99, and p99.9. Makes it visually unambiguous that the SPSC ring is the disciplined component (7.4 µs at p99) and that any tail risk in the system lives upstream in JSON parsing — not in the inter-thread transport.

### 2. System reliability profile

![Reliability profile](analysis/output/reliability_profile.png)

Same data reframed as an SLA conversation: *what fraction of ticks were processed within X µs?* Queue transit holds 99% of ticks under 7.4 µs and 99.9% under 47.9 µs. Parse latency is more variable end-to-end, with p90 at 22.5 µs already wider than the queue's p99.9.

### 3. Live time-series with spike detection

![Baseline time-series](analysis/output/baseline_timeseries.png)

Rolling p99 over a 500-tick window across 25k live ticks. Y-axis is locked to the 22 µs band so the steady state is visible; spike events that exceed the ceiling are tagged with hover-able markers rather than being allowed to compress the whole plot. The dashed line at 7 µs is the global p99 reference. The system runs near the floor with sporadic, isolated excursions — exactly the latency *shape* an HFT system should exhibit.

### 4. Producer-stall root-cause matrix

![Stall matrix](analysis/output/stall_matrix.png)

Correlates the time between consecutive ticks at the producer (x-axis) with queue transit latency (y-axis). The orange p99 line at 7 µs and the red 1 ms reference (the kernel's Generic Receive Offload boundary, where multiple frames coalesce into a single delivery) make it possible to attribute outliers to specific upstream causes — a coalesced batch of frames produces a cluster of correlated spikes, which is fundamentally a property of the kernel's network stack, not the user-space pipeline.

---

## What This Project Demonstrates

This is a quant-developer portfolio piece. The technical decisions map directly to the competencies hiring managers look for:

- **Lock-free concurrency.** Single-Producer/Single-Consumer ring buffer with explicit `memory_order_acquire` / `memory_order_release` semantics. Cache-line padding (`alignas(64)`) on `head_` / `tail_` to eliminate false sharing.
- **Cache-line-aware data layout.** `NormalizedTick` packed to exactly 64 bytes via bit-fields (`event_time : 56`). One tick = one cache line.
- **Hardware timing.** `__rdtscp` for sub-µs profiling, with runtime TSC calibration against Invariant TSC. Pipeline-serialized via the implicit LFENCE in `RDTSCP`.
- **Kernel-bypass-style persistence.** Memory-mapped, page-faulted, `mlock`'d output buffer. The hot path executes a 64-byte copy and a pointer increment — no `write()` syscall, no copy through kernel buffers.
- **OS-scheduler avoidance.** Threads pinned to physical cores via `pthread_setaffinity_np` / `SetThreadAffinityMask`. `SCHED_FIFO` real-time priority. Spin-poll with `__builtin_ia32_pause` rather than condition-variable wakeups.
- **Hierarchical bitboard order book.** Two-level bitmap (`L2` chunks → `L1` levels) over a contiguous price ladder. `__builtin_clzll` / `__builtin_ctzll` deliver O(1) best-price lookup that does not degrade in flash-crash scenarios.
- **Determinism over speed.** Fixed-point `int64_t` price and quantity throughout the pipeline. No floating-point on the hot path. ALU-only ASCII-to-integer parsing — bit-exact across hardware.
- **Production-grade recovery.** Sequence-gap detection drives a full state-machine recovery: halt strategy → cancel orders → wipe book → reconnect WS → re-snapshot via REST → replay → resume.
- **Honest analytical instrumentation.** The Python analysis layer doesn't just compute percentiles — it isolates root causes (queue vs. parse vs. kernel coalescing) and presents the data the way a senior engineer would want to read it.

### Scope Discipline

This project deliberately **does not** use SBE, Aeron, DPDK, or kernel bypass. Each was considered and excluded in favor of depth on the components that were retained. The ability to articulate *why* something was left out is itself part of the engineering signal — a kernel-bypass NIC integration to chase nanoseconds is meaningful only against a real strategy that needs it. This system is sized correctly for retail-API exchange ingestion and is honest about that boundary.

### The Zero-Cost Constraint

Everything here is built and measured on a **home desktop** — 12 logical cores, consumer DDR, no ECC, no colocation, no budget. That is a permanent constraint of this project, not a stage it will grow out of, and it is worth naming up front because it changes which optimisations are even available.

The gateway allocates two resources per instrument, and they hit their limits at very different places:

| Resource | Per instrument | Available here | Instruments before the wall |
| --- | ---: | ---: | ---: |
| Dedicated cores | 3 (producer / consumer / canary) | 12 logical | **3** |
| Locked order-book RAM | ~32.5 MB (2 × 16 MB price ladders) | 64 MB default `RLIMIT_MEMLOCK` (Ubuntu 26.04, measured) | **2** |

**The core wall is an artifact of our own design, not of the hardware.** Measured per tick: parse 9.59 µs, book update 6.67 µs, publish 0.39 µs. BTC delivers ~3.2 ticks/sec. That is **54 µs of real work per second** sitting on 3,000,000 µs/sec of allocated capacity — 0.002% utilisation. The cores are not full of work, they are full of *spinning*, and spin cost is constant rather than per-instrument. One spinning consumer can drain fifty ring buffers for the same core budget as one. The wall dissolves as soon as cores are allocated per *shard* instead of per *instrument*.

**The RAM wall is real.** [`order_book.hpp`](include/order_book.hpp) uses the price itself as an array index — that is what makes best-bid lookup ~0.6 ns, since there is no search, only a subscript. The cost of the trick is that the array must span the entire price range: `MAX_LEVELS = 2'000'000` × 8 bytes × 2 sides ≈ 32.5 MB per instrument, and it is `mlock`/`VirtualLock`'d resident. One hundred instruments is **3.25 GB of locked memory**. No amount of cleverness makes that free — it can only be shrunk, by indexing levels *relative to the mid* in a ~64 K-slot window and rebasing on drift (~512 KB/side, a 64× reduction) instead of indexing absolute price from zero.

#### Why production systems buy server hardware instead

A matching engine is **embarrassingly parallel across symbols and strictly serial within one symbol** — an order in AAPL can never match against MSFT, but every AAPL order can match every other AAPL order under legally-binding price-time priority. That single property dictates the physical architecture of every major exchange:

| Because… | The consequence |
| --- | --- |
| Symbols never interact | Symbols are **sharded across many machines**. Nasdaq's TotalView-ITCH is distributed over multiple multicast channels split by symbol range; the partitioning is visible from outside the exchange. |
| One symbol cannot be parallelised | **Clock speed beats core count.** The critical path is a single thread, so a 64-core part does not help and a faster core does. Exchange hardware selection looks nothing like a web company's. |
| Disk is ~10⁵× too slow | **The book is permanently RAM-resident.** Matching never touches disk; the journal is written by separate infrastructure off the critical path — the same hot-path rule this project follows, enforced with a far larger budget. |
| Light has a finite speed | **Colocation with length-equalised fibre.** Nasdaq's US equities matching runs from Carteret, NJ (NYSE from Mahwah). Racks are sold in the same building and every customer's fibre is cut to identical length so nobody is physically nearer the engine. At ~5 ns per metre, cable length *is* latency. |
| Text parsing is expensive | **Fixed-layout binary protocols** (ITCH for data, OUCH for order entry) — a message is a few dozen bytes you cast a struct over. |
| The kernel is a latency tax | **Kernel bypass or FPGA feed handlers**; packets reach userspace without traversing the kernel network stack. |

Two rows of that table are worth reading against this project's own numbers.

The first is **parse cost**. Our 9.59 µs `simdjson` parse against a near-free struct cast over a fixed-offset binary message is roughly a 1000× gap — and it is not a defect in this code. Hyperliquid publishes JSON over WebSocket; there is no parsing your way out of a text protocol. The largest single stage cost in this pipeline is a *venue protocol artifact*, and distinguishing costs that are yours to fix from costs that are imposed on you is most of the engineering judgement.

The second is **memory hardware**, which is where a desktop and a server genuinely diverge:

| | This desktop | Exchange-class server |
| --- | --- | --- |
| RAM ceiling | ~64–128 GB | 1–6 TB |
| Memory channels | 2 | 8–12 per socket |
| ECC | None — a flipped bit silently corrupts a book | Corrected and logged |
| Clock behaviour | Turbo / C-states float for power saving | Pinned flat in BIOS; determinism beats peak |
| SMT | On — two threads contend per core | Typically disabled on matching cores |
| NUMA | Single socket, invisible | Explicit; memory allocated on the socket that will touch it |
| Page size | 4 KB default | 1 GB huge pages |

The last row is easy to miss, and its cost is a function of scale rather than a constant. A 32.5 MB book spans ~8,300 4 KB pages, but the ladder is *sparse* — only a narrow band of levels around the mid is ever touched, so at one or two instruments the hot page set is a handful of entries and TLB pressure is negligible. Live measurement confirms it: the book-update stage runs at **p50 30 ns, p90 690 ns**, already the fastest stage in the pipeline. The pressure arrives with instrument count — a hundred books touching six to eight pages each approaches the capacity of a typical L2 TLB, at which point book accesses begin paying page-table walks of hundreds of nanoseconds. Huge pages collapse that mapping to a few entries regardless of instrument count: a problem solved by *purchasing* the right hardware rather than by writing better code.

Relative-indexed ladder windowing — shrinking 32.5 MB to ~1 MB per instrument by indexing levels against the mid instead of against zero — is first of all what makes a hundred instruments fit under `RLIMIT_MEMLOCK`. Whether it is *also* a latency fix depends on which ticks you look at, and an aggregate median hides the answer:

| book-update stage | p50 | p99 |
| --- | ---: | ---: |
| trade tick (field writes only) | 200 ns | 700 ns |
| depth tick (full snapshot diff, ~20 levels/side) | **5,030 ns** | 6,550 ns |

At ~125 ns per level against a ~2 ns array write, the depth path is not spending its time on arithmetic. The plausible explanation is that those ~40 levels land on ~40 different pages of a sparse 16 MB array — cache and TLB misses, which is precisely what a compact window would remove. That mechanism is untested here, so it is a hypothesis rather than a measured result; what is measured is that removing the per-depth-tick heap allocation from the same function bought only 11% (5,640 → 5,030 ns), so the cost lives somewhere other than the allocator.

Real exchanges pull both levers: shard the work, **and** buy the machine. A zero-cost budget removes the second lever entirely, leaving only sharding and shrinking. That is precisely why relative-indexed ladder windowing matters far more here than it would at Nasdaq — they can afford the address space, this project has to earn it back in design.

---

## Live Observability & Host-Noise Attribution

Everything in this section is a deliberate design choice, not a caveat bolted on after the fact.

### Watch it happen, don't wait for the postmortem

The original capture loop only produced a percentile table after the process exited — useful for a report, useless for noticing a problem *while it's happening*. Rather than treat that as acceptable, the gateway carries a second, cold-path-only pipeline: a lock-free ring buffer drains per-tick latency samples off the hot path into a dedicated export thread, which feeds an in-process geometric-bucket histogram (`include/live_histogram.hpp`) and a terminal progress view that updates p50/p99/p99.9/max **every second while the capture is still running**. The hot path never blocks on any of this — the ring buffer drops and counts on backpressure, exactly like the SPSC queue between the producer and consumer threads. Being able to *watch* a capture's tail behavior develop in real time, rather than reconstruct it after the fact from a CSV, is the point — not an incidental side effect of adding a progress bar.

That same geometric-bucket algorithm is ported three more times — once into the offline Python analysis (`analysis/export_summary.py`), once into the always-on relay's 12-hour rolling aggregator (`relay/src/histogram.ts`), and once into the web viewer's live tail detection (`web/src/lib/tailAttribution.ts`) — specifically so a percentile shown in the terminal during capture, in a downloaded summary afterward, and in the live web dashboard months later all agree with each other. Four implementations of the same small algorithm is a real cost; the alternative (four different approximations that quietly drift apart) is a worse one.

### Distinguishing "our pipeline was slow" from "the host was noisy"

Under WSL2, `isolcpus`-style core isolation only reaches the guest's *virtual* CPUs — it cannot pin anything away from whatever the Windows host itself decides to schedule on the corresponding physical core. That is a real, structural limitation of running a latency-sensitive pipeline under WSL2, and it means some fraction of any observed tail latency is host noise this process has no way to prevent.

The response to that limitation is not to hide it inside an unexplained tail, but to measure it directly. A dedicated jitter canary thread (`include/jitter_canary.hpp`) does nothing but target a fixed ~100µs interval in a loop, pinned to its own core, and record how far its actual wake time overshot the intended one. Because plain `sleep_for` at that resolution turned out to be a near-no-op on Windows (confirmed empirically, not assumed), the canary uses a hybrid sleep-then-spin approach to get a real, sub-millisecond-resolution reading rather than a number that never varies. That reading — `host_jitter_ns` — travels alongside every latency sample all the way to the web viewer.

Every tail-latency event (a sample above the session's own p99.9) is then attributed to one of two buckets: **host_jitter**, if that sample's own jitter reading is a statistical outlier relative to the session's baseline (median + 5×MAD, or an IQR-based approximation where only bucketed histograms are available — see `relay/src/rollingStatsAggregator.ts`), or a **specific pipeline stage** (parse / book-update / publish), if not. The web viewer's `TailEventsFeed` and `StageBreakdown` panels render these two cases differently on purpose: a host_jitter attribution shows up muted/grey with the canary delta, not a stage comparison, because showing "book-update was the outlier" for an event actually caused by host preemption would be actively misleading. A colored, stage-attributed event is a bug (or at least a cost) inside this codebase; a grey, jitter-attributed event is the platform doing something outside this process's control. Telling those apart, per-event, rather than reporting one blended tail number, is the actual deliverable of this half of the system.

### The full observability stack

```
C++ gateway (per-session, ephemeral)
  │  cold-path export (lock-free ring buffer, never blocks the hot path)
  ▼
Relay (Node/TypeScript, the only 24/7 piece)
  │  12-hour rolling stats, WebSocket fan-out to any number of viewers
  ▼
Web viewer (Next.js, deployed on Vercel)
     live L2 ladder + depth curve · trades tape · latency panel with
     tail-event drill-down · loads historical summary.json files too
```

The relay is intentionally the only piece that runs continuously — the gateway is a capture session, not a service, and the web viewer is stateless (it reconnects to the relay with the same backoff the gateway itself uses against Bybit). See [`relay/README.md`](relay/README.md) and [`web/README.md`](web/README.md) for how each piece is actually deployed.

---

## Build & Run

### Prerequisites

- C++20 compiler (GCC ≥ 11, Clang ≥ 13, or MSVC 2022)
- CMake ≥ 3.20
- Boost ≥ 1.78 (Beast, Asio, System)
- OpenSSL ≥ 1.1.1
- simdjson ≥ 3.0
- POSIX or Win32 platform (Linux preferred for production)

### Build

```bash
git clone https://github.com/berry0307/quant-command-center.git
cd quant-command-center/project-2-L2-market-data-gateway
./build.sh                        # or: cmake -B build && cmake --build build -j
```

### Capture

```bash
./build/L2DataCapture              # binds Core 2 (producer) + Core 3 (consumer)
                                   # writes ticks.bin and latency.csv into data/
```

The process pins itself, calibrates the TSC, and starts streaming from Bybit. `Ctrl-C` triggers a graceful, async-signal-safe shutdown via the atomic stop flag.

### Analyze

```bash
cd analysis
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
jupyter lab notebooks/latency_analysis.ipynb
```

The notebook reads `data/latency.csv` and `data/ticks.bin` and regenerates the four figures above. Static fallbacks are pre-rendered into `analysis/output/`.

---

## Repository Layout

```
project-2-L2-market-data-gateway/
├── include/                 C++ headers (one per component)
│   ├── ws_client.hpp        WebSocket ingress (Boost.Beast + simdjson)
│   ├── rest_client.hpp      Cold-path REST snapshot fetcher
│   ├── spsc_ring_buffer.hpp Lock-free transport (the central nervous system)
│   ├── order_book.hpp       PriceLadder + hierarchical bitboard
│   ├── mmap_writer.hpp      Zero-copy persistence
│   ├── rdtsc.hpp            Hardware timing + per-stage LatencyStore
│   ├── thread_utils.hpp     Core pinning, real-time priority
│   ├── AsyncLogger.hpp      Wait-free logging off the hot path
│   ├── parse_utils.hpp      ALU-only ASCII-to-int
│   ├── types.hpp            64B-aligned NormalizedTick, fixed-point scales
│   ├── export_pipeline.hpp  Cold-path SPSC ring buffer → gzip NDJSON export
│   ├── live_histogram.hpp   Geometric-bucket histogram (live progress view)
│   ├── jitter_canary.hpp    Dedicated host-noise measurement thread
│   └── thread_queue.hpp     (Legacy mutex queue — kept as reference)
├── src/                     C++ implementations
├── analysis/                Python latency-regime analysis
│   ├── notebooks/
│   │   └── latency_analysis.ipynb   ← analytical walkthrough
│   ├── output/                       ← rendered figures
│   ├── export_summary.py             ← offline tail-attribution + Altair charts
│   ├── latency_analysis.py
│   ├── metrics.py
│   ├── plots.py
│   └── ...
├── relay/                   Node/TypeScript relay — the only 24/7 piece
│   ├── src/                 BybitIngestClient, Broadcaster, ConnectionManager,
│   │                        RollingStatsAggregator, HealthMonitor
│   └── README.md            ← Oracle Cloud Free Tier deployment guide
├── web/                     Next.js live viewer, deployed on Vercel
│   ├── src/components/      OrderBookLadder, DepthCurve, TradesTape,
│   │                        LatencyPanel, SessionStatsHeader, ...
│   └── README.md            ← Vercel deployment guide
├── data/                    Sample captures (latency.csv, ticks.bin)
├── notes/
│   └── Engineering_Notes.md ← deep technical writeup, start here for depth
├── CMakeLists.txt
└── build.sh
```

---

## Three Documents, Three Altitudes

| Document | Audience | Time | What it covers |
| --- | --- | --- | --- |
| **This README** | Recruiter / hiring manager | 60 sec | What it is, the headline numbers, why it matters |
| **[`analysis/notebooks/latency_analysis.ipynb`](analysis/notebooks/latency_analysis.ipynb)** | Analyst / engineer | 10 min | How the system actually behaves on real data, with root-cause attribution |
| **[`notes/Engineering_Notes.md`](notes/Engineering_Notes.md)** | Senior reviewer | 1 hr+ | Architectural thesis, component-by-component theory, hardware-level rationale |

---

## Status & Roadmap

This is a working portfolio system, not an internal tooling product. Live captures run on a low-cost VPS to accumulate proprietary tick data; the analysis layer feeds off those captures.

**Shipped (v1.0.0):** per-stage rdtscp timestamps · cold-path export pipeline · live terminal progress view · jitter canary + host-noise attribution · offline Altair analysis · always-on relay with 12-hour rolling stats · web viewer (live L2 ladder, depth curve, trades tape) · latency panel with tail-event drill-down · Vercel + Oracle Cloud deployment.

**Next up:**

- Second-venue ingest (OKX) to validate the `NormalizedTick` schema as exchange-agnostic
- Book-validator artifact: cross-check that no captured taker trade prints inside the reconstructed spread (the single most differentiating piece of evidence the system is correct)
- Extended capture window for tail-risk analysis under macro-news events
- Parse-stage optimization to bring the full-pipeline tail closer to the queue's tail

---

## Acknowledgements

Built on the shoulders of: Martin Thompson's *Mechanical Sympathy* writings, Ulrich Drepper's *What Every Programmer Should Know About Memory*, Carl Cook's *When a Microsecond Is an Eternity* (CppCon 2017), Agner Fog's microarchitecture manuals, the Intel Software Developer's Manual, and WK Selph's classic limit-order-book post. Full citations in [`notes/Engineering_Notes.md`](notes/Engineering_Notes.md).

---

*Author: Barinder Singh · Part of the [quant-command-center](https://github.com/berry0307/quant-command-center) portfolio.*
