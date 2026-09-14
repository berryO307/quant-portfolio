#include "hyperliquid_adapter.hpp"
#include "parse_utils.hpp"

#include <boost/asio.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/beast/websocket/ssl.hpp>
#include <simdjson.h>

#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>

namespace net       = boost::asio;
namespace ssl       = net::ssl;
namespace beast     = boost::beast;
namespace websocket = beast::websocket;
using     tcp       = net::ip::tcp;

static const char* WS_HOST = "api.hyperliquid.xyz";
static const char* WS_PORT = "443";
static const char* WS_PATH = "/ws";

HyperliquidAdapter::HyperliquidAdapter(SpscRingBuffer<Tick, 1024>& queue,
                                        std::atomic<bool>& stop_flag,
                                        LatencyStore& latency,
                                        std::atomic<uint64_t>& last_u,
                                        std::string symbol)
    : queue_(queue), stop_flag_(stop_flag), latency_(latency), last_u_(last_u), symbol_(std::move(symbol)) {
    scratch_bids_.reserve(32);
    scratch_asks_.reserve(32);
}

void HyperliquidAdapter::run(Channel channel) {
    channel_      = channel;
    int  attempts = 0;
    auto delay    = RECONNECT_BASE_DELAY;

    while (!stop_flag_.load(std::memory_order_relaxed)) {
        ++attempts;
        std::cout << "[hl-ws] connect attempt #" << attempts << "  symbol=" << symbol_ << "\n";

        try {
            connect_and_read();

            delay    = RECONNECT_BASE_DELAY;
            attempts = 0;
            std::cout << "[hl-ws] clean disconnect — reconnecting immediately\n";

        } catch (const std::exception& e) {
            std::cerr << "[hl-ws] connection error: " << e.what() << "\n";

            if (!stop_flag_.load(std::memory_order_relaxed)) {
                std::cout << "[hl-ws] reconnecting in "
                          << std::chrono::duration_cast<std::chrono::seconds>(delay).count() << "s\n";
                std::this_thread::sleep_for(delay);
                delay = std::min(delay * RECONNECT_BACKOFF_MULT, RECONNECT_MAX_DELAY);
            }
        }

        if (!stop_flag_.load(std::memory_order_relaxed)) {
            trigger_resync();
        }
    }
}

void HyperliquidAdapter::connect_and_read() {
    net::io_context ioc;
    ssl::context ctx{ssl::context::tlsv13_client};
    ctx.set_verify_mode(ssl::verify_peer);
    ctx.set_default_verify_paths();

    websocket::stream<beast::ssl_stream<beast::tcp_stream>> ws{ioc, ctx};

    if (!SSL_set_tlsext_host_name(ws.next_layer().native_handle(), WS_HOST))
        throw std::runtime_error("SSL_set_tlsext_host_name failed");

    tcp::resolver resolver{ioc};
    auto results = resolver.resolve(WS_HOST, WS_PORT);

    try {
        beast::get_lowest_layer(ws).connect(results);
    } catch (const boost::system::system_error& e) {
        std::cerr << "[hl-ws] TCP connect failed: " << e.what() << "\n";
        throw;
    }

    ws.next_layer().handshake(ssl::stream_base::client);

    ws.set_option(websocket::stream_base::decorator(
        [](websocket::request_type& req) {
            req.set(boost::beast::http::field::user_agent, "quant-day1/1.0");
        }));

    ws.handshake(WS_HOST, WS_PATH);

    // Hyperliquid subscribes via a JSON method/subscription message, same
    // shape for a native coin ("BTC") or a builder-deployed sub-dex coin
    // ("xyz:CL") — confirmed live, symbol passed through as-is, no case
    // conversion (Hyperliquid coin names are case-sensitive, unlike
    // Bybit's uppercased-symbol convention).
    std::string sub_msg;
    if (channel_ == Channel::Trades) {
        sub_msg = R"({"method":"subscribe","subscription":{"type":"trades","coin":")" + symbol_ + R"("}})";
    } else {
        sub_msg = R"({"method":"subscribe","subscription":{"type":"l2Book","coin":")" + symbol_ + R"("}})";
    }

    ws.write(net::buffer(sub_msg));
    std::cout << "[hl-ws] subscribed: " << sub_msg << "\n";

    beast::flat_buffer buf;
    while (!stop_flag_.load(std::memory_order_relaxed)) {
        beast::error_code ec;
        beast::get_lowest_layer(ws).expires_never();
        ws.read(buf, ec);

        if (ec == websocket::error::closed) {
            std::cout << "[hl-ws] server closed connection\n";
            break;
        }
        if (ec == net::error::timed_out) {
            std::cerr << "[hl-ws] connection timed out (silent drop). Dropping socket...\n";
            break;
        }
        if (ec) {
            std::cerr << "[hl-ws] read error: " << ec.message() << "\n";
            break;
        }

        buf.reserve(buf.size() + simdjson::SIMDJSON_PADDING);
        simdjson::padded_string_view padded(
            static_cast<const char*>(buf.data().data()),
            buf.size(),
            buf.capacity()
        );

        dispatch(padded);
        buf.clear();
    }

    beast::error_code ec;
    ws.close(websocket::close_code::normal, ec);
}

void HyperliquidAdapter::trigger_resync() {
    ++reconnect_count_;
    std::cout << "[hl-ws] signalling consumer resync (reconnect #" << reconnect_count_ << ")\n";
    last_u_.store(0, std::memory_order_release);
}

// Every message is { "channel": "<name>", "data": ... }. subscriptionResponse
// (and anything else unrecognized) is skipped, same "no topic/channel we
// know -> ignore" shape as BybitAdapter::dispatch.
void HyperliquidAdapter::dispatch(simdjson::padded_string_view raw_msg) {
    uint64_t t1 = rdtscp();

    simdjson::dom::element doc;
    if (parser_.parse(raw_msg.data(), raw_msg.size(), false).get(doc)) return;

    std::string_view channel;
    if (doc["channel"].get(channel) != simdjson::SUCCESS) return;

    simdjson::dom::element data_field;
    if (doc["data"].get(data_field) != simdjson::SUCCESS) return;

    Tick tick{};
    bool ok = false;

    if (channel == "l2Book") {
        ok = parse_depth(data_field, tick);
    } else if (channel == "trades") {
        // Hyperliquid sends trades as an array, same as Bybit's publicTrade.
        simdjson::dom::array trade_arr = data_field;
        for (auto trade_elem : trade_arr) {
            Tick trade_tick{};
            if (parse_trade(trade_elem, trade_tick)) {
                uint64_t t2 = rdtscp();
                latency_.parse_cycles.emplace_back(t2 - t1);
                trade_tick.t1_tsc = t1;
                trade_tick.t2_tsc = t2;
                queue_.push(std::move(trade_tick));
            }
        }
        return;
    }

    if (ok) {
        uint64_t t2 = rdtscp();
        latency_.parse_cycles.emplace_back(t2 - t1);
        tick.t1_tsc = t1;
        tick.t2_tsc = t2;
        queue_.push(std::move(tick));
    }
}

// data = { coin, levels: [ [WsLevel...], [WsLevel...] ], time }, each
// WsLevel = {"px": "...", "sz": "...", "n": <int>}. Always a full snapshot
// (see this file's header comment) — pu=0 unconditionally, u/U set from
// Hyperliquid's own message timestamp (epoch ms, monotonically increasing
// per coin) purely as a strictly-increasing marker for main.cpp's existing
// last_u bookkeeping, not a real sequence-continuity number.
bool HyperliquidAdapter::parse_depth(simdjson::dom::element data, Tick& tick) {
    tick.data = DepthUpdate{};
    auto& d   = std::get<DepthUpdate>(tick.data);

    int64_t time_ms = 0;
    if (data["time"].get_int64().get(time_ms) != simdjson::SUCCESS) return false;

    d.u  = time_ms;
    d.U  = time_ms;
    d.pu = 0;
    d.event_time = time_ms;
    d.trans_time = time_ms;

    auto fill_levels = [](simdjson::dom::array arr, std::vector<PriceLevel>& out) {
        out.clear();
        for (auto row : arr) {
            PriceLevel lv;
            std::string_view px_sv, sz_sv;
            if (row["px"].get_string().get(px_sv) != simdjson::SUCCESS) continue;
            if (row["sz"].get_string().get(sz_sv) != simdjson::SUCCESS) continue;
            if (!parse_scaled(px_sv, lv.price, PRICE_SCALE)) continue;
            if (!parse_scaled(sz_sv, lv.qty, QTY_SCALE)) continue;
            out.push_back(lv);
        }
    };

    simdjson::dom::array levels;
    if (data["levels"].get_array().get(levels) != simdjson::SUCCESS) return false;

    simdjson::dom::array bid_levels, ask_levels;
    size_t idx = 0;
    for (auto side_arr : levels) {
        if (idx == 0) { if (side_arr.get_array().get(bid_levels) != simdjson::SUCCESS) return false; }
        else if (idx == 1) { if (side_arr.get_array().get(ask_levels) != simdjson::SUCCESS) return false; }
        ++idx;
    }
    if (idx < 2) return false;

    fill_levels(bid_levels, scratch_bids_);
    fill_levels(ask_levels, scratch_asks_);

    d.bids = std::move(scratch_bids_);
    d.asks = std::move(scratch_asks_);

    scratch_bids_.reserve(32);
    scratch_asks_.reserve(32);

    return true;
}

// One element of the trades[] array: {coin, side, px, sz, time, hash, tid, users}.
// side: "B" = buyer was the taker (lifted the ask) -> seller was maker ->
// is_buyer_maker=false; "A" = seller was the taker (hit the bid) -> buyer
// was maker -> is_buyer_maker=true. Confirmed empirically (not assumed
// from naming) by correlating 30 live trades against the concurrent best
// bid/ask: every "B" trade printed at the best ask, every "A" trade at the
// best bid — same is_buyer_maker semantic BybitAdapter::parse_agg_trade
// already uses ("S"=="Sell" -> true), just a different source field/values.
bool HyperliquidAdapter::parse_trade(simdjson::dom::element data, Tick& tick) {
    tick.data = AggTrade{};
    auto& t   = std::get<AggTrade>(tick.data);

    int64_t time_ms = 0;
    if (data["time"].get_int64().get(time_ms) != simdjson::SUCCESS) return false;
    t.event_time = time_ms;
    t.trade_time = time_ms;

    // Hyperliquid's trade id is already a plain integer, unlike Bybit's
    // UUID string (no hashing needed).
    if (data["tid"].get_int64().get(t.agg_trade_id) != simdjson::SUCCESS) return false;

    std::string_view px_sv, sz_sv;
    if (data["px"].get_string().get(px_sv) != simdjson::SUCCESS) return false;
    if (data["sz"].get_string().get(sz_sv) != simdjson::SUCCESS) return false;
    if (!parse_scaled(px_sv, t.price, PRICE_SCALE)) return false;
    if (!parse_scaled(sz_sv, t.qty, QTY_SCALE)) return false;

    std::string_view side_sv;
    if (data["side"].get_string().get(side_sv) == simdjson::SUCCESS) {
        t.is_buyer_maker = (side_sv == "A");
    }

    return true;
}
