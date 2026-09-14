#include "market_data_source.hpp"
#include "bybit_adapter.hpp"
#include "hyperliquid_adapter.hpp"

#include <stdexcept>

// The only place that branches on which exchange to talk to (see
// market_data_source.hpp's comment) — adding a third source later means a
// third case here and a third adapter class, nothing else changes.
std::unique_ptr<IMarketDataSource> make_market_data_source(
    const MarketDataSourceConfig& cfg,
    SpscRingBuffer<Tick, 1024>& queue,
    std::atomic<bool>& stop_flag,
    LatencyStore& latency,
    std::atomic<uint64_t>& last_u) {
    switch (cfg.exchange) {
        case MarketDataSourceConfig::Exchange::Bybit:
            return std::make_unique<BybitAdapter>(queue, stop_flag, latency, last_u, cfg.symbol);
        case MarketDataSourceConfig::Exchange::Hyperliquid:
            return std::make_unique<HyperliquidAdapter>(queue, stop_flag, latency, last_u, cfg.symbol);
    }
    throw std::runtime_error("make_market_data_source: unknown exchange");
}
