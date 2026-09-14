# Phase Tracker

Working notes for inspecting each phase of the L2 gateway build-out. Branch names, tags, what shipped, and key files to look at. Check items off as you review them.

Tag convention: `project-2-vX.Y.0`, one per phase, applied to the merge commit on `main` after each PR.

---

## Phase 1 — Per-stage timestamps

- **Branch:** `feature/stage-timestamps` · **Tag:** `project-2-v0.1.0`
- **What:** Split the single end-to-end latency measurement into four stage timestamps (recv/parse/book-update/publish) via `rdtscp`, purely additive — no hot-path reordering, no change to `NormalizedTick`.
- **Key files:** `include/rdtsc.hpp` (`LatencyStore` extended with `book_cycles`/`publish_cycles`), `src/main.cpp`, `src/ws_client.cpp`.
- [ ] Inspected

## Phase 2 — Cold-path export ring buffer

- **Branch:** `feature/cold-path-export` · **Tag:** `project-2-v0.2.0`
- **What:** A second lock-free SPSC ring buffer carrying per-tick samples, periodic L2 snapshots (top-10/side), and trade prints off the hot path to a dedicated drain thread, which writes gzip-compressed NDJSON. Hot path only ever calls `push()` — drops and counts on backpressure, never blocks.
- **Key files:** `include/export_pipeline.hpp` (new), `include/order_book.hpp`/`.cpp` (`top_bids`/`top_asks`), `src/main.cpp`.
- [ ] Inspected

## Phase 3 — Live histogram + terminal progress view

- **Branch:** `feature/live-capture-stats` · **Tag:** `project-2-v0.3.0`
- **What:** In-process geometric-bucket histogram (`LiveHistogram`) updated from the cold-path drain thread (never the hot path), plus a `TerminalProgressView` that prints p50/p99/p99.9/max/count in place, once a second, while a capture is still running.
- **Key files:** `include/live_histogram.hpp` (new), `include/terminal_progress.hpp` (new).
- [ ] Inspected

## Phase 4 — Jitter canary thread

- **Branch:** `feature/jitter-canary` · **Tag:** `project-2-v0.4.0`
- **What:** A thread with no purpose but measuring host scheduling noise — targets a fixed ~100µs interval on its own pinned core, records overshoot. **Bug found and fixed during build:** plain `sleep_for(100us)` was a near-no-op on Windows (~20ns measured, not ~100us) — switched to a hybrid sleep-then-spin approach. `host_jitter_ns` is now attached to every export sample.
- **Key files:** `include/jitter_canary.hpp` (new), `include/export_pipeline.hpp` (adds `host_jitter_ns` field).
- [ ] Inspected

## Phase 5 — Offline analysis with Altair charts

- **Branch:** `feature/offline-analysis` · **Tag:** `project-2-v0.5.0`
- **What:** `analysis/export_summary.py` — reads a session's NDJSON, computes percentiles via the *same* geometric-bucket algorithm as the C++ live histogram (so numbers agree), flags tail events (>p99.9) and attributes each to `host_jitter` (median+5×MAD) or a dominant pipeline stage, writes `summary.json` + dark-themed Altair charts.
- **Key files:** `analysis/export_summary.py` (new).
- [ ] Inspected

## Phase 6 — Live relay + rolling stats aggregator

- **Branch:** `feature/live-relay` · **Tag:** `project-2-v0.6.0`
- **What:** The only 24/7 piece. `BybitIngestClient` (relay-side handler for the gateway's push connection — relay is the WS *server*), `Broadcaster`/`ConnectionManager` (fan-out, drop-slow-clients-never-block), `RollingStatsAggregator` (12 hourly geometric-bucket histograms), `HealthMonitor`.
- **Key files:** `relay/src/*.ts` (new package).
- [ ] Inspected

## Phase 7 — Web viewer scaffold

- **Branch:** `feature/web-viewer-scaffold` · **Tag:** `project-2-v0.7.0`
- **What:** Next.js app — `OrderBookLadder`, `TradesTape`, `FeedStatusBanner`, wired to the relay's live WebSocket. **Bugs found and fixed during build:** relay had no CORS headers (blocked cross-origin browser fetches); a React StrictMode double-invoke race in the reconnect hook.
- **Key files:** `web/src/components/{OrderBookLadder,TradesTape,FeedStatusBanner}.tsx`, `web/src/lib/useRelayConnection.ts`.
- [ ] Inspected

## Phase 8 — Latency panel + tail drill-down

- **Branch:** `feature/latency-panel` · **Tag:** `project-2-v0.8.0`
- **What:** `LatencyPanel` — uPlot scatter chart, `TailEventsFeed`, `StageBreakdown` drill-down. Works against either a loaded Phase 5 `summary.json` (historical) or the relay's live sample stream (a fourth port of the tail-attribution logic, client-side).
- **Key files:** `web/src/components/{LatencyPanel,LatencyChart,TailEventsFeed,StageBreakdown}.tsx`, `web/src/lib/tailAttribution.ts`.
- [ ] Inspected

## Phase 9 — Depth curve + stats header

- **Branch:** `feature/depth-and-stats` · **Tag:** `project-2-v0.9.0`
- **What:** `DepthCurve` (cumulative bid/ask size vs price, hover-synced with the ladder), `SessionStatsHeader` (current-session vs trailing-12h, kept visually separate, with a host_jitter/pipeline split for each). **Two real bugs found and fixed:** a ref-timing bug that meant the depth chart's uPlot instance never got created; a classic `min-height: auto` Flexbox bug that silently clipped the chart's actual (correctly-rendered) content out of view.
- **Key files:** `web/src/components/{DepthCurve,SessionStatsHeader}.tsx`, `relay/src/rollingStatsAggregator.ts` (extended with a jitter histogram + IQR-based split).
- [ ] Inspected

## Phase 10 — Polish + deploy

- **Branch:** `feature/polish-and-deploy` · **Tag:** `project-2-v1.0.0` (pending — tag only after both `web/` and `relay/` are confirmed live)
- **What:** Consolidated 4 duplicated color palettes and 3 duplicated `formatNs()` copies into `web/src/lib/{theme,format}.ts` (found a real formatting bug in the process — two copies were missing the `ms` branch). New README section framing host-jitter attribution and live-capture-visibility as deliberate design choices. Deployment docs for Vercel (`web/`) and Oracle Cloud Free Tier (`relay/`). **Security fix:** added `INGEST_TOKEN` — the relay's `/ingest` endpoint had no authentication at all before this.
- **Key files:** `web/src/lib/{theme,format}.ts` (new), `relay/README.md` (new), `web/README.md`, `README.md`, `relay/src/bybitIngestClient.ts`.
- [ ] Inspected — currently a merged/unmerged PR, **not yet tagged**

---

## Status

All phases 1-9 are merged to `main` and tagged. Phase 10 is out for your review; `project-2-v1.0.0` is held until you confirm both `web/` (Vercel) and `relay/` (Oracle Cloud) are deployed and reachable.
