-- Neon Postgres schema for tick-data replay storage.
--
-- Design: one `sessions` row per captured .ndjson.gz file (see
-- ColdPathExporter in include/export_pipeline.hpp), one `ticks` row per
-- exported record (ExportRecord — sample/snapshot/coarse_snapshot/trade).
--
-- `ticks` mirrors ExportRecord's own tagged-union shape directly: a single
-- table with a `record_type` discriminator and nullable per-type columns,
-- rather than three separate tables. This was chosen over normalizing by
-- record type because replay needs the ORIGINAL interleaved order back
-- (the source NDJSON is one stream mixing sample/snapshot/trade lines as
-- they actually arrived) — one table with a single `seq` column and
-- `ORDER BY seq` reconstructs that trivially; three separate tables would
-- need an application-side merge-by-sequence to do the same thing, for no
-- real benefit at this data volume (hundreds to tens of thousands of rows
-- per session, not millions).
--
-- bids/asks are stored as JSONB arrays of [price, qty] pairs (same shape as
-- the wire format's SnapshotRecord/CoarseSnapshotRecord — see
-- relay/src/types.ts) rather than normalized into a levels table: up to 100
-- levels/side per snapshot, and JSONB keeps a snapshot row self-contained
-- and matches the wire shape exactly ("nothing gets lossy in translation"),
-- with no join needed to reconstruct one.
--
-- Run once against a fresh Neon database:
--   psql "$DATABASE_URL" -f scripts/schema.sql

CREATE TABLE IF NOT EXISTS sessions (
    id             BIGSERIAL PRIMARY KEY,
    -- Hyperliquid coin name as passed to quant_day1.exe, e.g. "BTC" or "xyz:CL".
    symbol         TEXT NOT NULL,
    -- Epoch ms of the ORIGINAL capture's start — parsed from the source
    -- file's own "session_<epoch_ms>.ndjson.gz" name, same value
    -- replay-gateway.mjs already parses for the wire protocol's capturedAt.
    captured_at_ms BIGINT NOT NULL,
    -- Calibrated TSC frequency at capture time (quant_day1.exe's "Calibrated
    -- Host TSC Frequency" log line) — every t_* / tsc value in this
    -- session's ticks is a raw cycle count and meaningless without it.
    cpu_ghz        DOUBLE PRECISION NOT NULL,
    -- Original filename, kept for traceability back to the .ndjson.gz cold
    -- backup (see relay/README.md's Neon section for why the file is kept,
    -- not replaced) and so re-running the migration against the same file
    -- is a safe no-op rather than a silent duplicate load.
    source_file    TEXT NOT NULL,
    record_count   BIGINT NOT NULL DEFAULT 0,
    loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (symbol, captured_at_ms)
);

CREATE TABLE IF NOT EXISTS ticks (
    session_id  BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- 0-based position in the session's original NDJSON stream. Not a
    -- per-record-type sequence — shared across all record types in this
    -- session so ORDER BY seq alone reconstructs the real arrival order.
    seq         BIGINT NOT NULL,
    record_type TEXT NOT NULL CHECK (record_type IN ('sample', 'snapshot', 'coarse_snapshot', 'trade')),

    -- sample fields (ExportSample / SampleRecord)
    t_recv                 BIGINT,
    t_parse                BIGINT,
    t_pop                  BIGINT,
    t_book                 BIGINT,
    t_publish              BIGINT,
    batch_index            INTEGER,
    batch_size             INTEGER,
    queue_overflow_dropped BIGINT,
    cpu_core               SMALLINT,

    -- shared by sample (depth side) and trade (resting side hit); NULL for
    -- snapshot/coarse_snapshot, which have no side of their own.
    side        TEXT,

    -- snapshot / coarse_snapshot / trade all carry a single `tsc`; sample
    -- does not (it has the five t_* stamps instead), so this stays NULL
    -- for sample rows.
    tsc         BIGINT,

    -- snapshot / coarse_snapshot fields (ExportSnapshot / SnapshotRecord /
    -- CoarseSnapshotRecord). nsigfigs is NULL for a primary (non-coarse)
    -- snapshot, matching ExportSnapshot's own "0 for a real SNAPSHOT
    -- record" convention (see export_pipeline.hpp).
    nsigfigs    INTEGER,
    bids        JSONB,
    asks        JSONB,

    -- trade fields (ExportTrade / TradeRecord)
    price         BIGINT,
    qty           BIGINT,
    trade_id      BIGINT,
    event_time_ms BIGINT,

    PRIMARY KEY (session_id, seq)
);

-- The replay loader's one real query per session: give it every row back in
-- original arrival order. session_id is already the leading column of the
-- primary key, so this index is redundant for that exact query — kept
-- anyway as a name-stable, intention-revealing index independent of
-- whatever the primary key's physical implementation happens to be.
CREATE INDEX IF NOT EXISTS ticks_session_seq_idx ON ticks (session_id, seq);
