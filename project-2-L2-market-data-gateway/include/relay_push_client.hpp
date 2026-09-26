#pragma once
#include "export_pipeline.hpp"
#include "spsc_ring_buffer.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <thread>

// Pushes cold-path export records to the relay's /ingest endpoint in real
// time, over a persistent outbound WebSocket connection — the direct-push
// path that relay/src/bybitIngestClient.ts's own header comment describes
// as "(not yet built)". Wired in as ColdPathExporter's on_record callback
// (see export_pipeline.hpp), so it runs ALONGSIDE the existing local
// session_*.ndjson.gz export, not instead of it.
//
// Isolation from the hot path (per this repo's hot-path rule) is two hops
// deep by construction:
//   trading/gateway thread -> export ring buffer -> ColdPathExporter's own
//   drain thread -> THIS class's ring buffer -> this class's own thread.
// push() (called from the drain thread) only ever does a bounded, lock-free,
// non-blocking ring-buffer write — the same drop-on-backpressure contract
// every other queue in this codebase already uses (SpscRingBuffer::push(),
// ColdPathExporter::push()). All actual network I/O — connecting,
// reconnect backoff, and the blocking ws.write() calls — happens on this
// class's own dedicated thread, so a relay that's slow, unreachable, or
// flapping can never stall the drain thread, let alone the trading thread.
//
// Bounded memory by construction, not by an added cleanup step: the ring
// is fixed-capacity (RELAY_PUSH_RING_CAPACITY slots of ExportRecord, ~340
// bytes each — a few MB, allocated once). Once full, new records are
// dropped and counted, exactly like every other backpressure point here —
// there's nothing to "read and delete" because nothing is ever allowed to
// accumulate past that bound in the first place.
class RelayPushClient {
public:
    // Matches HyperliquidAdapter's own reconnect constants exactly — see
    // relay/src/bybitIngestClient.ts's comment, which names this specific
    // backoff (1s base, x2, 30s cap) as what a gateway-side push client
    // should use.
    static constexpr auto RECONNECT_BASE_DELAY   = std::chrono::seconds(1);
    static constexpr auto RECONNECT_MAX_DELAY    = std::chrono::seconds(30);
    static constexpr int  RECONNECT_BACKOFF_MULT = 2;

    // host/port: the relay's ingest endpoint (ws://host:port/ingest, plain
    // TCP — this connection stays on localhost/the private network between
    // gateway and relay, not the public internet-facing side, matching
    // relay/README.md's local-dev default of no TLS on /ingest).
    // cpu_ghz: this session's calibrated TSC frequency — sent in the hello
    // handshake exactly as replay-gateway.mjs and the relay's own
    // HelloMessage contract (relay/src/types.ts) expect.
    // token: optional shared secret, mirrors the relay's INGEST_TOKEN env var.
    RelayPushClient(std::string host, std::string port, double cpu_ghz,
                     std::optional<std::string> token);
    ~RelayPushClient();

    RelayPushClient(const RelayPushClient&)            = delete;
    RelayPushClient& operator=(const RelayPushClient&) = delete;

    // Called from ColdPathExporter's drain thread only (via the on_record
    // callback). Never blocks.
    bool push(const ExportRecord& rec);

    uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

private:
    void run();
    void connect_and_send();

    // ~3.2KB/slot (ExportRecord is sized to its largest member, a 100-level-
    // per-side snapshot) * 2048 =~ 6.6MB — generous backlog for a live,
    // best-effort push (this is not the durable record; the local
    // .ndjson.gz export is), while staying well short of the original
    // export ring's ~22MB. See RelayPushClient's owning std::unique_ptr in
    // main.cpp: at this size the object itself is heap-allocated, not a
    // main()-stack local, for the same reason export_pipeline.hpp's own
    // comment gives for ExportRingBuffer (too big for a thread/call stack).
    static constexpr size_t RELAY_PUSH_RING_CAPACITY = 2048;
    using RelayPushRing = SpscRingBuffer<ExportRecord, RELAY_PUSH_RING_CAPACITY>;

    std::string  host_;
    std::string  port_;
    double       cpu_ghz_;
    std::optional<std::string> token_;
    RelayPushRing ring_;
    std::atomic<bool>    running_;
    std::atomic<uint64_t> dropped_{0};
    std::thread  thread_;
};
