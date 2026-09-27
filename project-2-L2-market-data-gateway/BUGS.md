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
