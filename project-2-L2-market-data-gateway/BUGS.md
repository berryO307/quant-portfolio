# Bug Tracker (scratch — not yet committed)

Running log of bugs found during manual inspection/testing, kept out of git until the batch is done and reviewed. Once everything below is resolved, mass-commit the underlying fixes (and this file, if you want it kept as a record — otherwise delete it).

**Format:** one entry per bug. `/fix` line holds the resolution once found — leave it as `/fix: (pending)` until then.

---

## 1. `napi-sys` panic on `next dev` — "Node-API symbol has not been loaded"

- **Where:** `web/`, Windows only, any bundler (Turbopack or `--webpack`)
- **Symptom:** Dev server started fine ("✓ Ready"), then crashed with a Rust panic (`napi-sys-2.4.0\src\functions.rs:7:3: Node-API symbol has not been loaded`) on the first page request. Reproduced identically after a full clean reinstall (`rm -rf node_modules .next && npm install`).
- **Investigation:** Not a TTY/console-attachment issue (reproduced identically with `npm run dev | cat`, ruling that out). Root cause, confirmed by inspecting `node_modules` directly: `@tailwindcss/node` pins its own `lightningcss@1.32.0` via a version range that didn't overlap with the top-level `^1.33.0`, so npm nested a **second, private copy** at `node_modules/@tailwindcss/node/node_modules/lightningcss` (and its matching `lightningcss-win32-x64-msvc` native binary) instead of deduping. Bumping the top-level `lightningcss` version alone never touched this nested copy — Node's module resolution finds it first from inside `@tailwindcss/node`, so the older binary kept loading regardless of what the top-level `package.json` said.
  - **Correction:** the "not a Node.js version issue, confirmed official Windows distribution" note originally here was **wrong** — see entry #2. This bug was real and worth fixing (a genuine dependency-resolution footgun), but it turned out not to be what was crashing the user's own terminal. Two independent bugs were stacked on top of each other, which is what made this so confusing to isolate.
- `/fix`: Added an `overrides` block to `web/package.json` forcing `lightningcss` and `lightningcss-win32-x64-msvc` to `^1.33.0` everywhere in the dependency tree (first attempt at an exact-pin `"1.33.0"` failed with npm's `EOVERRIDE` — a direct dependency's override must be compatible with its own declared range, so switched to `^1.33.0` to match). Verified via full clean reinstall (`rm -rf node_modules package-lock.json .next && npm install`) that only one `lightningcss` directory remains under `node_modules` (no nested copy under `@tailwindcss/node`). This fix is real and worth keeping (it removes a latent dependency-resolution hazard), but **did not by itself resolve the crash in the user's terminal** — see entry #2 for the actual blocker.

---

## 2. Same panic, still reproducing after fix #1 — actual root cause: wrong Node.js build (MSYS2/MinGW vs official MSVC)

- **Where:** the user's own MINGW64 terminal specifically. Never reproduced in a plain Bash-tool session run from the same machine/path, which is the clue that cracked it.
- **Symptom:** Identical panic to entry #1, byte-for-byte same stack trace, even after entry #1's fix was verified clean (single `lightningcss` copy, `1.33.0` everywhere, confirmed via `node -e "console.log(require.resolve('lightningcss'))"` resolving to the right path inside the project).
- **Investigation — the actual lesson:** `where node` in the user's terminal resolved to `C:\msys64\mingw64\bin\node.exe` — **MSYS2's own packaged Node.js** (`mingw-w64-x86_64-nodejs`), compiled with the MinGW/GCC toolchain. There was no official Node.js installation on the machine at all (`C:\Program Files\nodejs` didn't exist). Meanwhile, every native addon Next.js/Tailwind ship for Windows is named things like `lightningcss-win32-x64-msvc` and `@next/swc-win32-x64-msvc` — that `-msvc` suffix is not decorative, it means the `.node` binary was compiled against the **MSVC** C runtime/ABI. A MinGW-built Node.js host loading an MSVC-built native addon is a **binary ABI mismatch**: the addon's compiled code expects the N-API function table to be wired up the way MSVC's CRT/linker does it, and the MinGW-built Node runtime does it differently enough that N-API symbol registration silently fails — hence `Node-API symbol has not been loaded`, not a crash *in* the addon's logic. This is invisible from JavaScript entirely (`node --version`, `npm ls`, every `package.json`, every file in `node_modules` all look completely normal) because it's a mismatch at the native compiled-code level, one layer below anything npm/Node's module system can see or check.
  - Why version bumps never helped: every published Windows build of `lightningcss`/`@next/swc` is MSVC-targeted. There is no version of these packages that would load correctly under a MinGW-built Node — the fix was never going to be in `package.json`.
  - Why it never reproduced in the assistant's own Bash-tool session on the identical files/path: that session's `PATH` didn't have MSYS2's `/mingw64/bin` ahead of everything else, so it resolved to a different (correct, MSVC) `node.exe` — same repo, same `node_modules`, different **host binary** running it. A crash that "won't reproduce outside your exact terminal" is a strong hint to check *which binary is actually running*, not just what files are on disk.
  - Why PATH mattered here specifically: MSYS2/MINGW64 shells prepend `/mingw64/bin` to `PATH` ahead of the inherited Windows `PATH`, so any Windows-PATH-registered official Node.js install gets shadowed. Plain PowerShell/CMD don't do this — their `PATH` is just the Windows system `PATH`, so once an official Node.js is installed, they resolve to it with zero extra configuration.
- `/fix`: Installed the official Node.js Windows distribution (nodejs.org `.msi`, MSVC-built) — this was **not a version downgrade**, just installing the correct *build* of Node (any version works; the bug was never about version number). Ran `npm run dev` from a plain PowerShell terminal instead of MINGW64/Git-Bash, so `PATH` resolves to the official `C:\Program Files\nodejs\node.exe` instead of MSYS2's. No `node_modules` reinstall was needed — the native binaries in there were already the correct MSVC build all along; only the *host* Node process running them was wrong. **Confirmed fixed instantly.**
- **Takeaway for next time a native-addon panic looks "environment-cursed":** check `where node` / `Get-Command node` before touching any `package.json`. On Windows specifically, more than one Node.js can be installed via different package managers (official installer, MSYS2, nvm-windows, Chocolatey, Scoop...), and `PATH` order silently picks a winner per-shell. A native addon (anything with a platform-and-toolchain suffix like `-msvc`, `-gnu`, `-musl`) is only guaranteed to work with the Node build it was compiled against.

---

## 3. C++ gateway wouldn't compile — `-std=gnu++17` against C++20-only code

- **Where:** `build.sh`
- **Symptom:** Build failed on `src/ws_client.cpp`, which calls `string_view::starts_with()` — a C++20 library addition, not available under `-std=gnu++17`.
- **Investigation:** `CMakeLists.txt` already declares `CMAKE_CXX_STANDARD 20` for the CMake build path; `build.sh`'s own direct-compile path had drifted out of sync with it, still passing `-std=gnu++17`.
- `/fix`: Changed `build.sh` to `-std=gnu++20`, matching `CMakeLists.txt`. Confirmed by a clean rebuild succeeding.

---

## 4. Rebuilding without a manual clean fails link with duplicate-symbol errors

- **Where:** `build.sh`, the `ar.exe qc` step
- **Symptom:** A second `./build.sh` run (no clean in between) fails at link time with duplicate-symbol errors.
- **Investigation:** `ar qc` is quick-append — it does not replace existing members of an already-existing archive, it appends alongside them. Running the build twice without deleting `objects.a` first left two copies of every `.o` in the same archive.
- `/fix`: Added `rm -f "$BUILD/CMakeFiles/quant_day1.dir/objects.a"` immediately before the `ar qc` call, guaranteeing a fresh archive on every build. Verified: two consecutive builds (before/after the `EXPORT_SNAPSHOT_DEPTH` change) both succeeded cleanly with no duplicate-symbol errors.

---

## 5. Built executable fails with a missing-DLL error when run directly (Bash tool session only)

- **Where:** running `build/quant_day1.exe` directly from a Bash tool session (not via `build.sh`)
- **Symptom:** `libsimdjson.dll` (and similar MinGW-toolchain DLLs) not found at process start.
- **Investigation:** `build.sh` sets `PATH` to include `/c/msys64/mingw64/bin` internally before building/running; a separate Bash tool session invoking the built exe directly doesn't inherit that PATH, so Windows can't resolve the MinGW-built DLLs the exe links against.
- `/fix`: Prefix direct exe invocations with `PATH=/c/msys64/mingw64/bin:$PATH` in that session. Not a code bug — a session/environment setup gap, recorded here because it wasted time before the cause was obvious (same "check which binary/environment is actually running" lesson as entry #2).

---

## 6. Scratch files written to `/tmp/...` don't show up where expected

- **Where:** any workflow mixing MSYS2 bash tool calls with Windows-native `node.exe` reading/writing the same path
- **Symptom:** A file written to `/tmp/foo.json` from bash isn't found (or a different file's found) when a plain Windows `node` process reads `/tmp/foo.json`.
- **Investigation:** bash's `/tmp` (MSYS2's virtual root) and Windows-native node's `/tmp` (which resolves relative to the current drive, `<drive>:\tmp`) are two different physical locations — they only coincidentally share the string `/tmp`.
- `/fix`: Not a code bug — a cross-runtime path-resolution gotcha. Worked around each time by writing scratch files to a path relative to the project directory instead of `/tmp/...`, since that resolves identically in both runtimes. (The session's own scratchpad directory, introduced later, avoids this entirely for genuinely temporary files.)

---

## 7. Order book ladder bars read as nearly-empty after the export pipeline started carrying more levels

- **Where:** `web/src/components/OrderBookLadder.tsx`, bar-width scaling (`maxTotal`)
- **Symptom:** Once `EXPORT_SNAPSHOT_DEPTH` grew past the ladder's own fixed `LEVELS_PER_SIDE=12` display, every visible bar started rendering far shorter than its actual proportion of the two sides' *displayed* depth.
- **Investigation:** `maxTotal` was being read from `computeDepthLevels()`'s own max — computed over *all* real levels the snapshot carries (up to 100/side), not just the 12 nearest the spread actually rendered. Once the export depth exceeded what the ladder shows, the true max cumulative total increasingly lived in off-screen levels, so every on-screen bar was being scaled against a denominator far larger than anything visible.
- `/fix`: `maxTotal` is now recomputed locally from only the truncated near-spread slice actually rendered (`bidsNearSpread`/`asksNearSpread`), not the full-book max.

---

## 8. Depth curve cursor tooltip clipped/wrapped near the chart's right/bottom edge

- **Where:** `web/src/components/DepthCurve.tsx`, the floating cursor tooltip (`setCursor` hook)
- **Symptom:** Reported via screenshot — hovering near the right or bottom edge of the chart, the tooltip (placed at a fixed `cursor + 12px` offset) ran past the plotting area and visibly clipped/wrapped.
- **Investigation:** The offset was never checked against the container's actual bounds.
- `/fix`: Boundary-aware placement — compute `left`/`top` against `el.clientWidth`/`clientHeight`, flip to the opposite side of the cursor whenever the default placement would overflow, and clamp into `[2, max - size - 2]`.

---

## 9. Depth curve showed two misaligned vertical lines when hovering the chart itself

- **Where:** `web/src/components/DepthCurve.tsx`, hover-sync with `OrderBookLadder`
- **Symptom:** Reported via screenshot — hovering directly over the depth curve drew both uPlot's own native crosshair and the manual ladder-hover-sync overlay line at once, visibly offset from each other by a pixel or two.
- **Investigation:** The manual overlay exists for the *opposite* direction — a hover that originated on the ladder, reported up to shared state and drawn on the curve. It wasn't being suppressed when the curve's own native cursor already had the same `hoveredPrice` covered, so both draws fired for a curve-originated hover.
- `/fix`: `isSelfHoverRef`, set synchronously inside the `setCursor` hook whenever the native cursor is active; the ladder-hover-sync effect now skips drawing its own overlay line while it's true.

---

## 10. Depth curve Y-axis log scale misrepresented relative wall sizes

- **Where:** `web/src/components/DepthCurve.tsx`, Y-axis scale config
- **Symptom:** Not a crash/rendering bug — a correctness/design issue raised directly: log-scaling cumulative size made a genuinely much-larger resting order look only slightly taller than a small one, which is the one thing a depth chart exists to show truthfully.
- **Investigation:** Cumulative size is a physical quantity with a real "how much bigger" answer, unlike a latency chart's time axis (naturally multi-order-of-magnitude, no "true proportion" to preserve) — log-scaling it doesn't just restyle the chart, it changes what it visually claims about resting-order sizes.
- `/fix`: Reverted to a linear Y-axis (`range: (_u, _min, max) => [0, max]`). The actual fix for "too few points, jarring steps" was raising `EXPORT_SNAPSHOT_DEPTH` (10→50→100), not distorting the axis to paper over having only ~10 real levels.

---

## 11. Depth curve "big spikes" and bid/ask size imbalance — investigated, not a bug

- **Where:** `web/src/components/DepthCurve.tsx` / `web/src/lib/orderBook.ts` (`computeDepthLevels`)
- **Symptom:** Visually large, asymmetric jumps between the bid (green) and ask (red) cumulative-size curves — sometimes bid-heavy, sometimes ask-heavy, occasional single-level spikes far above their neighbors.
- **Investigation:** Directly inspected the raw captured `.ndjson.gz` snapshots (not inferred) on two separate occasions — once for the overall imbalance, once specifically re-scanning all 171 snapshots in a session for "spikes." Found genuine large single-level resting orders (e.g. a 26.327 BTC ask wall, a 12.068 BTC bid wall, both at/near top-of-book) actually present in the captured wire data, not introduced anywhere in `computeDepthLevels()` or `buildAlignedData()`. Cross-checked against Bybit's own website, which shows the same class of imbalance.
- `/fix`: Not a bug — real market depth. No code change. Recorded so this doesn't get re-investigated from scratch later.

---

## 12. Replay session goes silent after ~3 minutes — web shows "feed unavailable"

- **Where:** `relay/scripts/replay-gateway.mjs`
- **Symptom:** After replaying a captured session once in real time, the relay connection drops and the web dashboard reports the live feed as unavailable.
- **Investigation:** By design, the original script replayed the captured session exactly once at real-time pace, then closed its connection to the relay — there was no code to restart it, so once a short capture finished playing, the feed genuinely stopped.
- `/fix`: Added a `--loop` flag — `runLoop()` repeats `replayOnce()` for as long as the relay connection stays open, instead of exiting after a single pass.

---

## 13. Depth-level dropdown showed only one option

- **Where:** `web/src/components/DepthCurve.tsx`, `DepthLevelSelect`'s options list
- **Symptom:** The depth-level selector rendered a single, ungreyed-but-pointless option instead of a real range of choices.
- **Investigation:** The options loop runs `for (n = MIN_DEPTH_LEVELS; n < max; n += DEPTH_STEP)`, then always pushes `max` — with `MIN_DEPTH_LEVELS=50` and the live snapshot's actual ceiling *also* 50 (because `EXPORT_SNAPSHOT_DEPTH` was still 50 at the time), the loop condition `50 < 50` was never true, leaving only the one pushed `max` value.
- `/fix`: Bumped `EXPORT_SNAPSHOT_DEPTH` (`include/export_pipeline.hpp`) from 50 to 100, giving the selector real headroom above its floor (50, 60, 70, 80, 90, 100). Verified live against a fresh 100-depth capture replayed through the relay: snapshots arrive with 100 bids/100 asks.

---

## 14. Latency chart's elapsed-time axis ticks all read the same value

- **Where:** `web/src/lib/format.ts` (used by `web/src/components/LatencyChart.tsx`'s x-axis)
- **Symptom:** Every tick on the elapsed-time x-axis displayed the same string (e.g. every label "0.0s"), even though the underlying tick values were genuinely different.
- **Investigation:** The original formatter used a fixed one-decimal-second precision regardless of the actual data scale. The live scatter's visible sample window is frequently well under a second (samples can arrive at thousands/sec), so distinct tick values collapsed to identical rounded text.
- `/fix`: `formatElapsedAdaptive(valueSeconds, stepSeconds)` — picks unit (s/ms/µs) and decimal count from the *spacing between adjacent ticks*, not from the value being formatted, guaranteeing adjacent ticks render as visibly distinct strings. Verified this session by running (not hand-computing) the function's own worked examples in `node`: all four cases in its doc comment match exactly.

---

## 15. Latency chart crashed on load once its Y-axis went log-scale

- **Where:** `web/src/components/LatencyChart.tsx`, the latency-axis `values` callback
- **Symptom:** The chart crashed immediately on first load after switching its Y-axis to log scale (confirmed via a Playwright console-error capture, not just inferred from a blank panel).
- **Investigation:** A log-distribution axis (`distr:3`) generates minor gridline tick positions that uPlot represents as `null` rather than omitting — every other axis in the app only ever receives real numbers in its `values` callback, so `formatNs()` had no null guard and threw the moment a null tick reached it.
- `/fix`: `values: (_u, ticks) => ticks.map((t) => (t == null ? "" : formatNs(t)))`. The same null-guard pattern was applied proactively (not independently rediscovered) to `StageLatencyChart.tsx`'s equivalent log-scale axis when that component was built.

---

## 16. Latency-severity markers shared a color with the order book's ask side

- **Where:** `web/src/lib/theme.ts`, and everywhere `COLOR_ASK` was reused for p99.9/max latency markers (`LatencyChart`, `SessionStatsHeader`, `StageBreakdown`, `TailEventsFeed`)
- **Symptom:** Not a crash — a semantic/correctness issue. The same red used for "ask side of the order book" was also used for "severe latency outlier," two completely unrelated meanings sharing one color across different charts on the same dashboard.
- **Investigation:** `COLOR_SEVERE` didn't exist as its own token; latency-severity call sites were just reusing `COLOR_ASK` because it happened to be a red already defined.
- `/fix`: Introduced a dedicated `COLOR_SEVERE` token (desaturated relative to the bid/ask reds, so it doesn't visually compete with the new blue accent either) and repointed every latency-severity usage at it, leaving `COLOR_ASK` meaning only "ask."

---

## 17. Latency chart's cursor tooltip had the same unguarded edge-overflow bug as the depth curve (fixed proactively)

- **Where:** `web/src/components/LatencyChart.tsx`, the floating cursor tooltip
- **Symptom:** Not yet reported via screenshot at the time this was found — this component's tooltip used the exact same fixed `cursor + 12px` placement entry #8 had already been diagnosed and fixed for on `DepthCurve.tsx`, just not yet updated here.
- **Investigation:** Found by re-checking every other floating-tooltip call site in the codebase after fixing entry #8, rather than waiting for it to be independently reported here too.
- `/fix`: Applied the identical boundary-aware placement logic from entry #8 (compute against `el.clientWidth`/`clientHeight`, flip side on overflow, clamp into bounds). Verified with `tsc --noEmit` and `eslint` after the change — both clean.

---

## 18. uPlot's built-in legend overflowed its flex container

- **Where:** `web/src/app/globals.css`, `.u-legend` (uPlot's own generated `<table>`)
- **Symptom:** uPlot's built-in legend doesn't respect a flex parent's height/width constraints — it overflows its container instead of wrapping.
- **Investigation:** Global CSS override needed since the legend markup is generated by uPlot itself, not available to style via component JSX.
- `/fix`: `.u-legend { display:flex!important; flex-wrap:wrap!important; max-width:100%; ... }`, applied app-wide.
- **Note:** every chart in the current codebase (`LatencyChart`, `DepthCurve`, `StageLatencyChart`) now sets `legend:{show:false}` and renders a custom `LegendSwatch` row instead, so this rule may now be defending against a legend that's no longer rendered anywhere. Left in place rather than removed speculatively — low cost to keep, and removing it can't be verified safe without checking every future chart addition doesn't re-enable a native legend.

---

## 19. Order book depth silently collapsed from 20 real levels to 1-2 on a non-BTC instrument

- **Where:** `include/order_book.hpp` / `src/order_book.cpp`, `PriceLadder`
- **Symptom:** Found while verifying the new `HyperliquidAdapter` against a live `xyz:CL` (WTI crude oil) capture — every exported snapshot showed only 1-2 surviving bid/ask levels instead of the 20 the wire actually sent, with suspiciously round-looking prices (e.g. every level landing on an exact `.2000`/`.3000`).
- **Investigation:** `PriceLadder` indexed price levels via integer division by a hardcoded `TICK_STEP = 1000` (0.1 USDT) — sized for BTCUSDT, the project's only instrument until this point (the removed comment literally said "more than enough for BTCUSDT even in a flash crash"). WTI's real tick size is roughly $0.001-0.01: two genuinely distinct price levels closer together than $0.1 integer-divide to the SAME ladder index and silently overwrite each other. No crash, no error logged — just far fewer real levels surviving than were actually sent. Not Hyperliquid-specific: any instrument with a tick size finer than Bybit's BTC convention would hit the same collision.
- `/fix`: `tick_step` is now a per-`PriceLadder` runtime field (default 1000, so any ladder that never gets the new parameter behaves identically to before), set by `init()` from a value `OrderBook::seed()` infers fresh from each snapshot's own price data — the finest step that still can't collide two genuinely distinct prices actually present in it, clamped to `[1, 1000]`. Self-adjusts per instrument with zero manual configuration. Verified: a second live BTCUSDT capture came back byte-identical in behavior (100/100 levels/side, 0 gaps), and a re-run of the `xyz:CL` capture after the fix showed 20/20 levels/side with correct distinct granular prices.

---

## 20. Hyperliquid depth updates triggered a resync on every single tick

- **Where:** `src/main.cpp`, `consumer_loop`'s `InSync` state
- **Symptom:** First live `HyperliquidAdapter` test run: every depth message logged as a "GAP", forcing a full resync loop continuously instead of ever settling into steady-state tracking.
- **Investigation:** The `InSync` branch ran Bybit's delta-continuity check (`pu` must exactly equal the book's `current_last_u`) unconditionally. Hyperliquid's `l2Book` channel has no delta protocol at all — every message is a full snapshot, so `HyperliquidAdapter` correctly sets `pu=0` (the project's existing "this is a snapshot" sentinel) on every single message. `pu=0` can never equal a nonzero `current_last_u`, so the check tripped every time. `OrderBook::apply_depth` already had correct handling for `pu==0` (unconditional reseed) — the bug was `consumer_loop`'s own pre-check running the continuity comparison before ever looking at whether this message even claimed to be a snapshot.
- `/fix`: Skip the continuity check entirely when `depth->pu == 0`, and let `book.apply_depth()` handle the reseed the way it already correctly does. This was latent for Bybit too, in principle — its own existing comments already noted mid-stream snapshots are rare-but-possible, and this path would have mishandled that case identically. Verified: a live 1-minute `xyz:CL` capture came back with zero GAP messages and 11 clean reseeds.

---

## 21. Bybit's REST ticker silently rejected the 24h-change request

- **Where:** `web/src/lib/use24hChange.ts` (the Bybit branch this describes has since been deleted — Bybit support was removed entirely, prompted by this same round of bug-hunting)
- **Symptom:** 24h-change figure never appeared for the Bybit instrument, no error surfaced anywhere (by design — a failed peripheral-context fetch fails silently).
- **Investigation:** Bybit's REST ticker rejects lowercase symbols outright — confirmed live: `symbol=btcusdt` returns `{"retCode":10001,"retMsg":"params error: symbol invalid"}`, `symbol=BTCUSDT` returns `200 OK`. `lib/instruments.ts`'s `symbol` field was deliberately lowercase to match the gateway CLI's own convention (which the WS side case-insensitively uppercased internally).
- `/fix`: Uppercased the symbol specifically at the Bybit REST call site, not by changing the shared instrument config's casing. Moot now that Bybit support has been removed entirely, but recorded since the same lowercase-symbol assumption could resurface if a future source's REST API is similarly case-sensitive.

---

## 22. "Live feed unavailable" when selecting a Hyperliquid instrument — no live gateway→relay bridge exists

- **Where:** Architectural, not a single file — `relay/src/bybitIngestClient.ts` accepts a live push connection from the gateway at `/ingest`, but the C++ gateway (`src/main.cpp`) has never actually implemented that outbound connection. The class's own comment says so directly: "The (not yet built) gateway-side push client should reconnect with the same backoff already used for the Bybit feed..."
- **Symptom:** Selecting any instrument in the web dropdown whose relay port doesn't already have something feeding it shows the existing (correct) "feed unavailable" state — this is not a bug in the dropdown, the relay, or the gateway; it's the dropdown accurately reporting that nothing is currently pushing data to that port.
- **Investigation:** Every "live" feed this entire project has ever shown, for any instrument, has actually been a previously-captured `.ndjson.gz` session replayed after the fact via `relay/scripts/replay-gateway.mjs --loop` — never a genuinely real-time push from a running `quant_day1.exe` process. This was true for Bybit throughout the whole project and remains true for Hyperliquid; nothing about the Hyperliquid migration changed this — it surfaced now because switching the *default* dropdown instrument to Hyperliquid (BTC, port 8080) left that port's previous feed (a replayed Bybit session) stopped, with nothing yet replaying Hyperliquid data in its place.
- `/fix`: Operational, not a code fix — capture a real Hyperliquid session (`./build/quant_day1.exe <minutes> <symbol>`) and replay it into the relevant port with `relay/scripts/replay-gateway.mjs <session>.ndjson.gz <port> <cpu_ghz> --loop`. Done for the default BTC instrument (port 8080) as part of this same round. A real-time gateway→relay push client (the "(not yet built)" one `bybitIngestClient.ts` already anticipates) remains unbuilt — worth its own dedicated feature if genuinely live (not replayed) data ever becomes a requirement, since today's entire pipeline, for every instrument, is capture-then-replay.

---

## 23. Depth curve's spot-price marker sometimes rendered deep inside the bid or ask side

- **Where:** `web/src/components/DepthCurve.tsx`, the permanent spot-price marker line (`positionSpotLine`)
- **Symptom:** Reported via screenshot (WTI instrument, "1s" mode) — the dashed vertical marker, meant to sit exactly at the bid/ask boundary, instead rendered many real price levels deep into the green (bid) region, clearly separate from where the chart's own green/red fill actually transitioned.
- **Investigation:** Exhaustively ruled out the data first, not assumed clean: checked all 18 snapshots in the actual captured `.ndjson.gz` file and 15 consecutive live snapshots from the relay — every single one was correctly sorted, never crossed, with the computed midpoint always tight between best bid and best ask. The bug was in the rendering layer. The marker's x-position was read from `midPriceRef` — a price value computed once in `buildAlignedData` and stashed in a ref *alongside* (not *from*) the actual `plot.setData(data)` call — two independent copies of "the same" value whose consistency depended entirely on both being set together correctly on every code path, forever. The exact trigger for them drifting apart wasn't pinned down to one specific line, but the two-copies structure itself is the kind of bug class that only needs one missed/reordered update anywhere to misfire.
- `/fix`: `buildAlignedData` now returns a `bridgeIdx` (the marker's position *within uPlot's own data array*) instead of a separately-computed price. `positionSpotLine` reads the marker's x-value as `plot.data[0][bridgeIdx]` — uPlot's own current data, not a side-channel copy of it — so the marker's position and the plot's own rendered data are structurally the same read. This doesn't just patch the specific trigger found; it removes the entire "two copies of the same value can drift apart" bug class this was an instance of.

---

## 24. Depth-level dropdown always showed a single misleading "50 levels" option

- **Where:** `web/src/components/DepthCurve.tsx`, `MIN_DEPTH_LEVELS`/`DEPTH_STEP`
- **Symptom:** User asked whether more depth was available from Hyperliquid, having noticed the dropdown only ever offered one option, "50 levels" — even though the chart visibly rendered far fewer points than that.
- **Investigation:** Checked directly against the live Hyperliquid API rather than assuming: REST `l2Book` with `nSigFigs` set to 2, 3, 4, and 5 all returned exactly 20 bids + 20 asks, every time — `nSigFigs` only changes price-aggregation granularity (how wide a price range 20 levels spans), never the level count. Confirmed: 20/side is a hard platform cap, not a client-side limitation, with no deeper feed available via REST, WS, native, or dex-scoped coins. `MIN_DEPTH_LEVELS` was still 50 — a leftover from when this fed Bybit's up-to-100-level export pipeline — which could never be reached now that every source caps at 20, so the selector's options loop (`for n=50; n<max; n+=10`) never ran, always leaving just the one pushed `max` value, itself frozen at the 50-floor rather than the real 20.
- `/fix`: Lowered `MIN_DEPTH_LEVELS` to 5 and `DEPTH_STEP` to 5, giving real dropdown choices (5/10/15/20) once live data arrives. Also changed the default `depthLevels` state from "start at the floor" to a large sentinel that always resolves to "show everything available" — with a real ceiling this shallow, defaulting to a quarter of the book read as broken rather than deliberately narrowed.

---

## 25. Latency panel charts rebuilt the entire uPlot instance on every data update

- **Where:** `web/src/components/LatencyChart.tsx`, `web/src/components/StageLatencyChart.tsx`
- **Symptom:** Reported as generally "visually noisy/buggy" (via screenshot) — axis ticks looked like they were recalculating on every render, and points never transitioned smoothly between updates.
- **Investigation:** Both components had `new uPlot(...)` inside the SAME effect whose dependency array included `points` — which changes on every sample-flush batch (`useRelayConnection`'s `SAMPLE_FLUSH_INTERVAL_MS = 250ms`), i.e. up to ~4 times/second for the total-latency chart and each of the 4 per-stage charts in the latency panel. Every one of those was a full teardown (`plot.destroy()`) and rebuild of the canvas, DOM, and every internal uPlot data structure — not an update to an existing chart, a brand new one each time. A comment on the original code explicitly defended this ("construction cost is negligible next to the ~250ms cadence") — true in isolation, but wrong about the visible effect: rebuilding the instance is exactly what produces jumpy axes and no continuity between frames. `DepthCurve.tsx` was checked too and does NOT have this problem — it already separates a mount-once effect from a `plot.setData()` update effect.
- `/fix`: Split both components into a mount effect (creates the instance once, empty initial data; deps: `[minHeight]` for `StageLatencyChart`, plus `color` since a color change there means a different stage chart entirely) and a data-update effect that calls `plot.setData()` on a persistent instance. Values read inside hooks/callbacks defined once at mount (the tooltip's `setCursor` handler, the x-axis tick-label formatter) now read from refs or from `u.data` (uPlot's own current data) instead of closing over `points`/`cpuGhz` directly, which would otherwise go stale the moment the instance stopped being recreated on every update.

---

## 26. Dev console showed "Encountered a script tag while rendering React component"

- **Where:** `web/src/app/layout.tsx`, the anti-flash-of-wrong-theme inline `<script>` in `<head>`
- **Symptom:** Next.js dev overlay showed a "1 Issue" badge with this warning, pointing at `layout.tsx`'s `<script dangerouslySetInnerHTML={...} />`.
- **Investigation:** A known React 19 false positive, not a functional bug — React 19 warns on ANY raw `<script>` element anywhere in the render tree, which is exactly the anti-FOUC theme-init pattern (same open issue reported against next-themes, shadcn/ui's own dark-mode guide, and HeroUI as of Sept 2026, with no clean upstream fix). The script still executes correctly and the theme still applies with no flash — this is dev-console noise about a pattern React itself has no alternative recommendation for yet. Removing the inline script instead would reintroduce the actual flash-of-wrong-theme it exists to prevent.
- `/fix`: Suppress the specific warning string in development only, via a small `console.error` patch prepended to the SAME synchronous inline script (not a separate module loaded via a client component's `useEffect` — the warning fires DURING React's hydration pass, before any effect could run, so a useEffect-based patch would always be too late to catch it). Gated by `process.env.NODE_ENV === "development"` at render time, so nothing ships to production.

---

## 27. Total-latency panel's p99/p99.9 reference lines clipped against the top axis edge

- **Where:** `web/src/components/LatencyChart.tsx`, `scales.y`
- **Symptom:** The p99 and p99.9 dashed reference lines rendered bunched at the very top of the chart, visually overlapping each other and clipping into the axis boundary instead of reading as distinct lines.
- **Investigation:** No explicit `range` function was set on the log-scale y-axis (`scales: { y: { distr: 3, log: 10 } }`), so uPlot's default auto-ranging clamped tightly to `[min, max]` of the plotted data — and since p99.9 is frequently at or near the actual max value in the dataset, its own reference line ended up defining (or nearly defining) the top of the visible range, leaving it no room to render as a separate line below the axis edge.
- `/fix`: Added an explicit `range: (_u, min, max) => [Math.max(min, LOG_FLOOR_NS), max * 1.2]`, giving 20% headroom above whatever the highest value (data point or reference line) actually is. Also reduced all three reference lines' stroke opacity to 70% (`withAlpha`) — full-opacity dashed lines were competing with the scatter points for visual attention rather than reading as de-emphasized context behind them.
