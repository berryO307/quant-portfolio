"""
Offline analysis for a Phase 2 cold-path export session (gzip NDJSON).

Reads a session_<epoch_ms>.ndjson.gz file produced by ColdPathExporter
(see include/export_pipeline.hpp), computes percentiles using the same
geometric-bucket histogram as the Phase 3 in-process LiveHistogram (see
include/live_histogram.hpp) so live and offline numbers agree, flags tail
events (samples above the session's global p99.9) and attributes each one
to either host jitter or the dominant pipeline stage, and writes a compact
summary.json plus exploratory Altair charts for offline review.

Usage:
    python export_summary.py <session.ndjson.gz> [--cpu-ghz 3.2] [--out-dir DIR]

Note: the calibrated TSC frequency (host_ghz) is never persisted in the
NDJSON — only raw TSC values are (same gap analysis/reader.py already has
for latency.csv). Pass --cpu-ghz with the value the gateway printed at
startup ("[main] Calibrated Host TSC Frequency: ... GHz") if it isn't ~3.2.
"""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

import altair as alt
import numpy as np
import pandas as pd

alt.data_transformers.disable_max_rows()


# ── Geometric bucket histogram — mirrors include/live_histogram.hpp ────────
# Same boundary construction and cumulative-count lookup as
# LiveHistogram::LiveHistogram()/snapshot(), NOT np.percentile, so a
# percentile computed here from the full session agrees with what the
# terminal progress view showed live during capture.

_BUCKET_RATIO = 1.01
_BUCKET_MAX_NS = 1 << 31  # ~2.1s ceiling; larger values clamp into the top bucket


def _build_bucket_boundaries() -> np.ndarray:
    boundaries = [1]
    v = 1
    while v < _BUCKET_MAX_NS:
        nxt = int(v * _BUCKET_RATIO)
        if nxt <= v:
            nxt = v + 1   # guard against rounding stalls at small v — matches the C++ guard
        v = nxt
        boundaries.append(v)
    return np.array(boundaries, dtype=np.int64)


BUCKET_BOUNDARIES = _build_bucket_boundaries()


def _bucket_index(values_ns: np.ndarray) -> np.ndarray:
    """Assign each value to a bucket via lower_bound semantics (side='left'),
    matching std::lower_bound in LiveHistogram::record()."""
    values_ns = np.clip(np.asarray(values_ns, dtype=np.int64), 1, None)
    idx = np.searchsorted(BUCKET_BOUNDARIES, values_ns, side="left")
    return np.clip(idx, 0, len(BUCKET_BOUNDARIES) - 1)


def bucket_snapshot(values_ns: np.ndarray) -> dict:
    """
    p50/p99/p99.9/max/count via the same bucket-and-cumulative-count method
    as LiveHistogram::snapshot(). Integer-division percentile targets and the
    strict `cumulative > target` lookup are copied exactly so the numbers
    match what a live capture would have shown at the same point.
    """
    values_ns = np.clip(np.asarray(values_ns, dtype=np.float64), 1, None)
    n = len(values_ns)

    idx = _bucket_index(values_ns)
    counts = np.bincount(idx, minlength=len(BUCKET_BOUNDARIES))
    cumulative = np.cumsum(counts)

    t50, t99, t999 = (n * 50) // 100, (n * 99) // 100, (n * 999) // 1000

    def _lookup(target: int) -> float:
        i = int(np.searchsorted(cumulative, target, side="right"))
        i = min(i, len(BUCKET_BOUNDARIES) - 1)
        return float(BUCKET_BOUNDARIES[i])

    return {
        "count":   int(n),
        "p50_ns":  _lookup(t50),
        "p99_ns":  _lookup(t99),
        "p999_ns": _lookup(t999),
        "max_ns":  float(values_ns.max()),
    }


# ── Session loading ──────────────────────────────────────────────────────────

def load_session(path: str | Path, cpu_ghz: float = 3.2) -> pd.DataFrame:
    """
    Read a gzip NDJSON session and return SAMPLE records as a DataFrame with
    derived per-stage and end-to-end latency columns, in nanoseconds.
    """
    path = Path(path)
    rows = []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    if not rows:
        raise ValueError(f"No records found in {path}")

    df = pd.DataFrame(rows)
    samples = df[df["type"] == "sample"].reset_index(drop=True).copy()
    if samples.empty:
        raise ValueError(f"No sample records found in {path}")

    for col in ("t_recv", "t_parse", "t_book", "t_publish"):
        samples[col] = samples[col].astype(np.int64)
    samples["host_jitter_ns"] = samples["host_jitter_ns"].astype(np.int64)

    ns_per_cycle = 1.0 / cpu_ghz
    samples["parse_ns"]       = (samples["t_parse"]   - samples["t_recv"])  * ns_per_cycle
    samples["book_update_ns"] = (samples["t_book"]    - samples["t_parse"]) * ns_per_cycle
    samples["publish_ns"]     = (samples["t_publish"] - samples["t_book"])  * ns_per_cycle
    samples["latency_ns"]     = (samples["t_publish"] - samples["t_recv"])  * ns_per_cycle

    return samples


# ── Tail event detection + attribution ──────────────────────────────────────

# Matches latency.csv's existing column names (Phase 1/2) exactly.
STAGE_COLUMNS = {"parse": "parse_ns", "book-update": "book_update_ns", "publish": "publish_ns"}


def find_tail_events(samples: pd.DataFrame, percentiles: dict) -> tuple[pd.DataFrame, dict]:
    """
    Flag samples above the session's global p99.9 as tail events and
    attribute each one to "host_jitter" (if this sample's own
    host_jitter_ns is elevated relative to the session baseline) or to
    whichever of the three measurable stage deltas is largest.

    Baseline/threshold: median + 5*MAD of host_jitter_ns across the whole
    session (same robust-statistics approach analysis/metrics.py already
    uses for jitter elsewhere), falling back to median + 1000ns if MAD == 0
    (a session where jitter is essentially constant, so any nonzero
    deviation would otherwise look "infinitely elevated").
    """
    threshold = percentiles["p999_ns"]
    tail = samples[samples["latency_ns"] > threshold].copy()

    jitter = samples["host_jitter_ns"].to_numpy(dtype=np.float64)
    baseline = float(np.median(jitter))
    mad = float(np.median(np.abs(jitter - baseline)))
    jitter_threshold = baseline + (5.0 * mad if mad > 0 else 1000.0)

    jitter_info = {"baseline_ns": baseline, "elevated_threshold_ns": jitter_threshold}

    if tail.empty:
        return tail, jitter_info

    stage_vals = tail[list(STAGE_COLUMNS.values())].to_numpy()
    dominant_stage = np.array(list(STAGE_COLUMNS.keys()))[np.argmax(stage_vals, axis=1)]

    is_host_jitter = tail["host_jitter_ns"].to_numpy() > jitter_threshold
    tail["attribution"] = np.where(is_host_jitter, "host_jitter", dominant_stage)

    return tail, jitter_info


# ── Summary JSON ─────────────────────────────────────────────────────────────

def build_summary(session_path: Path, samples: pd.DataFrame, percentiles: dict,
                   tail: pd.DataFrame, jitter_info: dict, cpu_ghz: float) -> dict:
    duration_ns = float(samples["t_publish"].max() - samples["t_recv"].min()) / cpu_ghz
    return {
        "session": {
            "path": str(session_path),
            "cpu_ghz_used": cpu_ghz,
            "n_samples": int(len(samples)),
            "duration_s_approx": duration_ns / 1e9,
        },
        "percentiles_ns": percentiles,
        "host_jitter": jitter_info,
        "tail_events": [
            {
                "index":          int(idx),
                "t_recv_tsc":     int(row.t_recv),
                "latency_ns":     float(row.latency_ns),
                "host_jitter_ns": int(row.host_jitter_ns),
                "attribution":    row.attribution,
                "stage_ns": {
                    "parse":       float(row.parse_ns),
                    "book_update": float(row.book_update_ns),
                    "publish":     float(row.publish_ns),
                },
            }
            for idx, row in tail.iterrows()
        ],
    }


# ── Altair theme + charts ────────────────────────────────────────────────────
#
# No dark UI theme exists yet elsewhere in this repo (the ImGui/Next.js
# tracks in CLAUDE.md aren't built) — this is a first-cut GitHub-dark-style
# palette meant to be swapped for the real one once the web app exists.

ATTRIBUTION_COLORS = {
    "normal":      "#484f58",
    "host_jitter": "#d29922",
    "parse":       "#58a6ff",
    "book-update": "#bc8cff",
    "publish":     "#3fb950",
}

_MAX_SCATTER_POINTS = 50_000   # exploratory charts, not the full-fidelity data


def register_dark_theme() -> None:
    """
    Minimalist dark Altair theme: no view border/stroke, gridlines stripped
    except faint horizontal ones (same "horizontal-only" convention as
    analysis/style.py's matplotlib theme), near-black background.
    """
    @alt.theme.register("gateway_dark", enable=True)
    def _theme() -> alt.theme.ThemeConfig:
        return alt.theme.ThemeConfig({
            "background": "#0d1117",
            "view": {"stroke": "transparent", "strokeWidth": 0},
            "axis": {
                "domainColor":  "#30363d",
                "tickColor":    "#30363d",
                "labelColor":   "#8b949e",
                "titleColor":   "#c9d1d9",
                "labelFontSize": 11,
                "titleFontSize": 12,
                "grid":         False,
            },
            "axisY": {"grid": True, "gridColor": "#21262d", "gridOpacity": 0.5},
            "legend": {"labelColor": "#c9d1d9", "titleColor": "#c9d1d9"},
            "title":  {"color": "#f0f6fc", "fontSize": 14, "anchor": "start"},
        })


def _sample_for_scatter(samples: pd.DataFrame, tail: pd.DataFrame) -> pd.DataFrame:
    """Cap scatter charts at _MAX_SCATTER_POINTS for reasonable HTML size,
    always keeping every tail event (the rare, analytically important rows)
    and randomly downsampling the rest to fill the remaining budget."""
    if len(samples) <= _MAX_SCATTER_POINTS:
        return samples
    non_tail = samples.drop(index=tail.index, errors="ignore")
    budget = max(_MAX_SCATTER_POINTS - len(tail), 0)
    sampled = non_tail.sample(n=min(budget, len(non_tail)), random_state=42)
    return pd.concat([samples.loc[tail.index], sampled]).sort_index()


def chart_latency_scatter(samples: pd.DataFrame, tail: pd.DataFrame) -> alt.Chart:
    """Latency over time, one point per sample. Opacity kept low so density
    reads through overlap; tail events are distinguished by color, not by
    standing out via higher opacity."""
    plot_df = _sample_for_scatter(samples, tail)[["t_recv", "latency_ns"]].copy()
    plot_df["attribution"] = "normal"
    if not tail.empty:
        common = plot_df.index.intersection(tail.index)
        plot_df.loc[common, "attribution"] = tail.loc[common, "attribution"]

    return (
        alt.Chart(plot_df)
        .mark_point(opacity=0.2, filled=True, size=14)
        .encode(
            x=alt.X("t_recv:Q", title="recv (TSC)"),
            y=alt.Y("latency_ns:Q", title="end-to-end latency (ns)", scale=alt.Scale(type="log")),
            color=alt.Color(
                "attribution:N",
                scale=alt.Scale(domain=list(ATTRIBUTION_COLORS.keys()),
                                 range=list(ATTRIBUTION_COLORS.values())),
                legend=alt.Legend(title="attribution"),
            ),
        )
        .properties(title="End-to-end latency over the session", width=700, height=320)
    )


def chart_latency_histogram(samples: pd.DataFrame, percentiles: dict) -> alt.Chart:
    """Bucketed latency distribution using the same geometric buckets as the
    percentile computation above, with p50/p99/p99.9 marked as rules."""
    idx = _bucket_index(samples["latency_ns"].to_numpy())
    counts = np.bincount(idx, minlength=len(BUCKET_BOUNDARIES))
    hist_df = pd.DataFrame({"bucket_ns": BUCKET_BOUNDARIES, "count": counts})
    hist_df = hist_df[hist_df["count"] > 0]

    bars = (
        alt.Chart(hist_df)
        .mark_bar(opacity=0.85, color=ATTRIBUTION_COLORS["parse"])
        .encode(
            x=alt.X("bucket_ns:Q", title="end-to-end latency (ns, log)", scale=alt.Scale(type="log")),
            y=alt.Y("count:Q", title="samples"),
        )
    )
    rules = (
        alt.Chart(pd.DataFrame({
            "value": [percentiles["p50_ns"], percentiles["p99_ns"], percentiles["p999_ns"]],
            "label": ["p50", "p99", "p99.9"],
        }))
        .mark_rule(color=ATTRIBUTION_COLORS["host_jitter"], strokeDash=[4, 3])
        .encode(x="value:Q")
    )
    return (bars + rules).properties(title="Latency distribution (geometric buckets)", width=700, height=320)


def chart_jitter_over_time(samples: pd.DataFrame, tail: pd.DataFrame) -> alt.Chart:
    """host_jitter_ns over time — same low-opacity treatment as the latency
    scatter, since it's also one point per sample."""
    plot_df = _sample_for_scatter(samples, tail)[["t_recv", "host_jitter_ns"]]
    return (
        alt.Chart(plot_df)
        .mark_point(opacity=0.2, filled=True, size=14, color=ATTRIBUTION_COLORS["host_jitter"])
        .encode(
            x=alt.X("t_recv:Q", title="recv (TSC)"),
            y=alt.Y("host_jitter_ns:Q", title="host_jitter_ns"),
        )
        .properties(title="Host jitter canary reading over the session", width=700, height=320)
    )


# ── Entry point ──────────────────────────────────────────────────────────────

def run(session_path: Path, out_dir: Path, cpu_ghz: float) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    samples = load_session(session_path, cpu_ghz=cpu_ghz)
    percentiles = bucket_snapshot(samples["latency_ns"].to_numpy())
    tail, jitter_info = find_tail_events(samples, percentiles)

    summary = build_summary(session_path, samples, percentiles, tail, jitter_info, cpu_ghz)
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    print(f"wrote {summary_path}  ({len(samples)} samples, {len(tail)} tail events)")

    register_dark_theme()
    chart_latency_scatter(samples, tail).save(out_dir / "latency_scatter.html")
    chart_latency_histogram(samples, percentiles).save(out_dir / "latency_histogram.html")
    chart_jitter_over_time(samples, tail).save(out_dir / "host_jitter.html")
    print(f"wrote charts to {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("session", type=Path, help="Path to session_*.ndjson.gz")
    parser.add_argument("--cpu-ghz", type=float, default=3.2,
                         help="Calibrated TSC frequency printed at gateway startup (default: 3.2)")
    parser.add_argument("--out-dir", type=Path, default=None,
                         help="Output directory (default: output/<session name>/)")
    args = parser.parse_args()

    session_name = args.session.stem.replace(".ndjson", "")
    out_dir = args.out_dir or Path("output") / session_name
    run(args.session, out_dir, args.cpu_ghz)


if __name__ == "__main__":
    main()
