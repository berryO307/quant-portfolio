#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <variant>

// Price level
// NOTE: PRICE_SCALE is deliberately oversized (10000 instead of 10) so the mid-price 
// can be calculated precisely using int64_t, preventing floating-point errors and truncation on 1-tick spreads.

static constexpr int64_t PRICE_SCALE = 10000; // Derived from Binance tickSize (0.1) and stepSize (0.001)
static constexpr int64_t QTY_SCALE   = 1000;

// Production-grade representation: prices and quantities stored as scaled int64_t (ticks) 
// to eliminate floating-point precision errors and ensure deterministic matching behavior.

struct PriceLevel {
    int64_t price;
    int64_t qty;
};

// Binance futures depthUpdate event
struct DepthUpdate {
    int64_t event_time;   // E
    int64_t trans_time;   // T
    int64_t U;            // first update id in event
    int64_t u;            // final update id in event
    int64_t pu;           // final update id in last stream (for gap check)
    std::vector<PriceLevel> bids;
    std::vector<PriceLevel> asks;
};

// Binance futures aggTrade event
struct AggTrade {
    int64_t event_time;     // E
    int64_t trade_time;     // T
    int64_t agg_trade_id;   // a
    int64_t price;          // p
    int64_t qty;            // q
    bool    is_buyer_maker; // m  (true = seller is taker = sell-side aggression)
};

// Tagged union pushed onto the inter-thread queue
enum class TickType : uint8_t { DEPTH, AGG_TRADE };

// Type-safe tagged union using std::variant to store either DepthUpdate or AggTrade.
// Uses overlapping memory (size of largest member only), eliminating memory bloat
// and improving cache efficiency for inter-thread communication.
using TickData = std::variant<DepthUpdate, AggTrade>;

struct Tick {
    TickData data;
    // Per-stage latency measurement (rdtscp, see rdtsc.hpp):
    // t1_tsc is captured on recv, before parsing begins.
    // t2_tsc is captured after parsing but before queue push.
    uint64_t t1_tsc = 0;
    uint64_t t2_tsc = 0;
};

// REST snapshot 
struct OrderBookSnapshot {
    int64_t last_update_id;
    std::vector<PriceLevel> bids;
    std::vector<PriceLevel> asks;
};

// Struct layout:
// 1 combined bit-packed word (8 bytes) = 8 bytes
// 7 fields of int64/uint64 (8 bytes each) = 56 bytes
// Total data bytes = 64.
// __attribute__((packed)) forces exactly 64 bytes with no padding.
struct __attribute__((packed)) NormalizedTick {
    // --- 1st 8-byte word (Bit-packed) ---
    int64_t  event_time     : 56; // (56 bits) exchange-reported timestamp (ms)
    int64_t  is_buyer_maker : 2;  // (2 bits) 1=buyer maker, 0=seller maker, -1=depth update
    int64_t  stream_type    : 1;  // (1 bit) 0=depth, 1=trade
    int64_t  is_gap_resync  : 1;  // (1 bit) on the first tick after a resync, 0 otherwise
    int64_t  reserved       : 4;  // (4 bits) Pad to complete the 64-bit word

    // --- Remaining 56 bytes ---
    int64_t  price;               // (8) scaled int e.g., 425000000 = $42500.00 (x10000)
    int64_t  qty;                 // (8) scaled int (x1000)
    int64_t  best_bid;            // (8) from reconstructed order book
    int64_t  best_ask;            // (8) from reconstructed order book
    int64_t  agg_trade_id;        // (8) MUST be 64-bit for Binance. 0 for depth updates.
    uint64_t t2_tsc;              // (8) rdtscp stamp at producer push (latency chain)
    int64_t  u;                   // (8) <- u: for verifying contiguity in post-analysis
};

// Verify at compile time. 64 is correct based on the 64-bit requirement for Trade IDs.
static_assert(sizeof(NormalizedTick) == 64, "NormalizedTick layout changed");