# Bug / Investigation Log

Numbered entries: Where / Symptom / Investigation, with a `/fix` line holding
the resolution (or current status, for anything still open).

---

## #1 — Free-tier cloud deployment: queue-stage tail latency, tens of ms

**Where**: `l2-gateway` (Oracle Cloud `VM.Standard.E2.1.Micro`, Always Free
tier — 1 shared physical core / burstable vCPU), pushing live Hyperliquid BTC
data to `l2-relay` and the public web viewer.

**Symptom**: production queue-stage latency (the SPSC ring's push→pop time)
showed P99/P99.9 in the tens of milliseconds, with a worst-case max of
47-52ms — two to three orders of magnitude worse than the same binary on
dedicated desktop hardware.

**Investigation** (real correlated measurement throughout, not guessing):

1. **Hypervisor CPU steal** — real (`vmstat`'s `%st` sat at a sustained
   ~31-37% baseline on this box), but a proper per-second Pearson
   correlation between `%steal` and queue latency across 215 seconds of live
   data, matched against exact spike timestamps recovered from the exported
   session, came back at **r = 0.029**. Every one of the six largest observed
   spikes occurred at baseline steal (33.7-37.9%), not the 80-100% a direct
   causal spike would need. **Ruled out.**
2. **Swap/memory pressure** — `si`/`so` were zero across every second
   checked, including every spike moment. **Ruled out.** (Separately found
   and fixed: `mmap_writer.hpp`'s `mlock()` on the 610MB tick buffer
   genuinely fails on this box from insufficient `RLIMIT_MEMLOCK` — the log
   used to unconditionally claim "Pages locked" regardless; now reports the
   real outcome. Doesn't change this conclusion since nothing was actually
   swapping.)
3. **Disk I/O / writeback stalls** — `iostat -x` at the exact spike seconds
   showed `%util` under 1% and `await` in single-digit ms. **Ruled out.**
4. **A competing guest process** — per-second `ps` snapshots at every spike
   timestamp showed no anomalous process. **Ruled out** as a single-heavy-
   process explanation (see the timer finding below for what this check's
   per-process framing had missed).

**Actual mechanism, confirmed by fixing it**: ordinary CFS scheduler
fairness on the single shared core — between this process's own threads,
and (the dominant factor) between this process and periodic non-essential
guest-side timers (`apt-daily`, `fwupd-refresh`, `motd-news`,
`update-notifier-*`, etc.), invisible to per-process CPU monitoring since it
never shows up as one obviously-heavy competing process.

Two levers, in order, each measured before/after on real live traffic:

- **Scoped `SCHED_FIFO`** for exactly the threads that benefit (3 hot-path +
  `export_drain` + `relay_push`, not process-wide — an earlier, unscoped
  attempt via systemd's `CPUSchedulingPolicy=fifo` elevated all 10 threads
  by accident via scheduling-policy inheritance from a legacy main-thread
  call, a real SSH-lockout risk on a 1-core box that was caught and reverted
  before shipping). Verified safe every time via `sched_rt_runtime_us=950000`
  (kernel RT-throttling floor), a dead-man's-switch systemd timer, and a
  genuinely separate second-SSH-session responsiveness probe.
- **Disabling six non-essential periodic timers** (`systemctl list-timers`
  surfaced them) plus moving `logrotate` to weekly. This was the bigger win
  by far.

**Result**: P99 45.16ms → 0.158ms (~285x), P99.9 73.61ms → 52.41ms. Not a
complete fix — 4 of 829 samples (0.48%) in the final measured window still
spiked to 10-52ms, and that residual was consistent across every
`SCHED_FIFO` scope tried.

**/fix**: shipped as `project-2-v2.5.2` through `v2.5.4` (see git tags for
full detail). The residual 0.48% tail is treated as the honest ceiling of
this specific shared/virtualized single-core shape — not something further
in-guest tuning is expected to close, the same conclusion already reached
for steal/swap/disk-I/O above. **Decision**: moved live public serving off
this deployment entirely in favor of a real desktop-captured replay session
(see the root README's "Known Limitations" section and the replay-pipeline
work this entry is filed alongside) — sub-50µs with zero spikes is not
achievable on any shared-vCPU tier we can afford, free or paid, since both
sit behind the same kind of hypervisor. `l2-gateway` itself is stopped, not
decommissioned, in case a dedicated-core tier is worth revisiting later.

---

## #2 — Desktop capture: queue-stage latency exceeds 50µs target, one dominant burst

**Where**: `L2DataCapture` (`quant_day1.exe`) running natively on desktop
hardware (AMD Ryzen 5 3600X, 6 physical/12 logical cores, Windows,
`Ultimate Performance` power plan) — no virtualization, no hypervisor,
the machine this project's core-pinning scheme was originally developed
against.

**Symptom**: a 1-hour, non-elevated BTC capture (14,418 samples) showed
queue-stage P50=5.84µs (fine) but P90=51.93µs, P99=577.0µs, P99.9=646.6µs,
max=652.8µs — missing a sub-50µs/1hr target, and worse than this project's
own historical desktop baseline from an earlier phase (P99=7.4µs,
P99.9=47.9µs).

**Investigation**:

- **Distribution shape, not a pervasive slowdown**: only 12 distinct seconds
  out of 2,789 (0.43% of the run) had *any* sample exceed 50µs. **One single
  second** (`22:35:35Z`) accounted for 961 of the total 1,038 over-threshold
  samples — a single stall-and-backlog-drain event (the recovered values
  form a smooth descending staircase, 652.83µs → 646.61µs, all at the same
  wall-clock instant), not sustained contention. The other 11 seconds were
  much smaller, isolated blips scattered through the remaining 99.57% of the
  run.
- **Thread affinity/pinning (checked, not assumed)**: `grep`'d the entire
  hour-long log for "Failed Affinity"/"Failed Priority" — zero hits.
  Pinning held for the full run (`claimed physical 1 -> consumer=2
  producer=3`).
- **Windows power plan / thermal**: `Ultimate Performance` was already
  active before the run started; desktop CPU, no thermal-throttling
  applies.
- **`-march=native` mismatch**: ruled out — built fresh via `build.sh` on
  this exact machine immediately before the run.
- **Hot-path heap allocation**: ruled out via code review —
  `LatencyStore::record()` explicitly checks `size() < capacity()` before
  `push_back`, guaranteeing no reallocation; the run used 14,418 of
  2,000,000 reserved slots.
- **Competing background load**: inconclusive. A 2-second-granularity CPU/
  memory monitor and the Windows System/Defender event logs showed nothing
  unusual at the exact burst moment, but a ~650µs event is roughly 3,000x
  shorter than that monitor's sampling interval — this negative result
  doesn't rule the mechanism out, it just means this monitoring approach
  can't resolve an event this short.
- **Elevation / true `REALTIME_PRIORITY_CLASS`**: the capture logs its own
  warning when not running elevated — `"requested REALTIME_PRIORITY_CLASS
  but the process is actually running at High"`. A short (2-minute, 236-
  sample) smoke test run from an elevated (Administrator) terminal achieved
  true `REALTIME_PRIORITY_CLASS` (no fallback warning printed) and measured
  P50=4.36µs, P90=19.07µs, P99=34.04µs, P99.9=35.15µs, max=35.68µs — every
  percentile comfortably under 50µs, with a much smaller max/median ratio
  than the non-elevated run (~8x vs ~112x).

**/fix**: **open, not concluded.** The elevated smoke test's clean numbers
are suggestive but explicitly NOT a substitute for a full validation — 2
minutes is far too short a window to expect to catch or rule out an event
whose only confirmed occurrence was one second out of 3,600. A full 1-hour
*elevated* capture, directly comparable to the non-elevated 1-hour baseline
above, has not yet been run. Until that happens, whether running elevated
actually eliminates or merely reduces the burst class of event remains
unconfirmed. The single 1-hour non-elevated burst itself also remains
mechanistically unexplained beyond "not pinning, not power plan, not
`-march`, not heap allocation, and not resolvable at 2-second monitoring
granularity."
