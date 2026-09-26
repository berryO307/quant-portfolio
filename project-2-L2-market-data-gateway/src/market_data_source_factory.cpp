#include "market_data_source.hpp"
#include "hyperliquid_adapter.hpp"

// Hyperliquid is currently the only source (Bybit was removed — see
// market_data_source.hpp's comment). Kept as its own function rather than
// main.cpp constructing HyperliquidAdapter directly so a second source can
// be added here later without touching main.cpp or anything downstream.
std::unique_ptr<IMarketDataSource> make_market_data_source(
    const MarketDataSourceConfig& cfg,
    SpscRingBuffer<Tick, 1024>& queue,
    std::atomic<bool>& stop_flag,
    LatencyStore& latency,
    std::atomic<uint64_t>& last_u,
    std::atomic<uint64_t>& queue_overflow_dropped) {
    return std::make_unique<HyperliquidAdapter>(queue, stop_flag, latency, last_u, queue_overflow_dropped, cfg.symbol);
}
