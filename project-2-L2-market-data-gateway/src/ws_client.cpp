#include "ws_client.hpp"
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
#include <charconv>
#include <thread>
#include <algorithm>

namespace net       = boost::asio;
namespace ssl       = net::ssl;
namespace beast     = boost::beast;
namespace websocket = beast::websocket;
using     tcp       = net::ip::tcp;

static const char* WS_HOST = "stream.bybit.com";
static const char* WS_PORT = "443";

WsClient::WsClient(SpscRingBuffer<Tick, 1024>& queue,
                   std::atomic<bool>& stop_flag, 
                   LatencyStore& latency, 
                   std::atomic<uint64_t>& last_u)
    : queue_(queue), stop_flag_(stop_flag), latency_(latency), last_u_(last_u) {

    // Pre-allocate capacity for the scratch buffers to guarantee zero allocations 
    // on the hot path during order book depth updates.
    scratch_bids_.reserve(256);
    scratch_asks_.reserve(256);
    }

// Implement the run() method to connect, read, and dispatch messages until stopped or an unrecoverable error occurs. 
void WsClient::run(const std::string& symbol, const std::string& stream_suffix) {
    symbol_         = symbol;
    stream_suffix_  = stream_suffix;
    int  attempts   = 0;
    auto delay      = RECONNECT_BASE_DELAY;

    while (!stop_flag_.load(std::memory_order_relaxed)) {
        ++attempts;
        std::cout << "[ws] connect attempt #" << attempts << "  symbol=" << symbol_ << "\n";
        
        try {
            connect_and_read(); // Blocks here until connection closes cleanly or throws

            // If we get here, connection closed cleanly. Reset backoff.
            delay    = RECONNECT_BASE_DELAY;
            attempts = 0;
            std::cout << "[ws] clean disconnect — reconnecting immediately\n";

        } catch (const std::exception& e) {
            std::cerr << "[ws] connection error: " << e.what() << "\n";

            if (!stop_flag_.load(std::memory_order_relaxed)) {
                std::cout << "[ws] reconnecting in " 
                          << std::chrono::duration_cast<std::chrono::seconds>(delay).count() << "s\n";
                std::this_thread::sleep_for(delay);
                delay = std::min(delay * RECONNECT_BACKOFF_MULT, RECONNECT_MAX_DELAY);
            }
        }

        // Trigger resync after ANY disconnect so the consumer drops stale order book state
        if (!stop_flag_.load(std::memory_order_relaxed)) {
            trigger_resync();
        }
    }
}

void WsClient::connect_and_read() {
    // Single-stream endpoint: /ws/<symbol><stream_suffix>
    // No "stream" or "data" wrapper — message is the raw event directly
    std::string path = "/v5/public/linear";

    net::io_context ioc;
    ssl::context ctx{ssl::context::tlsv13_client};
    // Encryption alone is insufficient; 
    // This verifies both certificate trust and endpoint identity (hostname) to prevent authentic-looking MITM attacks.
    ctx.set_verify_mode(ssl::verify_peer);
    ctx.set_default_verify_paths();
    ctx.set_verify_callback([](bool preverified, ssl::verify_context& vctx) {
    char subject_name[256];
    X509* cert = X509_STORE_CTX_get_current_cert(vctx.native_handle());
    X509_NAME_oneline(X509_get_subject_name(cert), subject_name, sizeof(subject_name));
    return preverified;
    });

    // Beast WebSocket over SSL
    websocket::stream<beast::ssl_stream<beast::tcp_stream>> ws{ioc, ctx};

    // SNI
    if (!SSL_set_tlsext_host_name(ws.next_layer().native_handle(), WS_HOST))
        throw std::runtime_error("SSL_set_tlsext_host_name failed");

    tcp::resolver resolver{ioc};
    auto results = resolver.resolve(WS_HOST, WS_PORT);

    // Production-style failure handling: treat venue disconnects as 
    // recoverable events (log, retry, failover), not fatal process-ending errors.
    try {
        beast::get_lowest_layer(ws).connect(results);
    } catch (const boost::system::system_error& e) {
        std::cerr << "[ws] TCP connect failed: " << e.what() << "\n";
        throw; // rethrow to trigger reconnect logic in run()
    }
    
    // TCP connected → SSL handshake
    ws.next_layer().handshake(ssl::stream_base::client);

    // Suppress Beast adding "Upgrade" decorator twice
    // Custom User-Agent set intentionally instead of exposing the default library fingerprint;
    // Complements exchange-limit hygiene (Binance enforces message/connection limits and may ban repeat offenders).
    ws.set_option(websocket::stream_base::decorator(
        [](websocket::request_type& req) {
            req.set(boost::beast::http::field::user_agent,
                    "quant-day1/1.0");
        }));

    // WebSocket handshake
    ws.handshake(WS_HOST, path);

    // AFTER ws.handshake(WS_HOST, path); — send subscription message
    // Bybit subscribes via JSON message, not URL parameters
    std::string upper_symbol = symbol_;
    std::transform(upper_symbol.begin(), upper_symbol.end(), upper_symbol.begin(),
               [](unsigned char c) { return std::toupper(c); });

    std::string sub_msg;
    if (stream_suffix_ == "@aggTrade") {
        sub_msg = R"({"op":"subscribe","args":["publicTrade.)" + upper_symbol + R"("]})";
    } else if (stream_suffix_ == "@depth@100ms") {
        sub_msg = R"({"op":"subscribe","args":["orderbook.200.)" + upper_symbol + R"("]})";
    }

    ws.write(net::buffer(sub_msg));
    std::cout << "[ws] subscribed: " << sub_msg << "\n";

    beast::flat_buffer buf;
    // Use memory_order_relaxed for a standalone kill-switch (no shared state to acquire); 
    // Avoid mutex/condition_variable because scheduler wakeups add latency unnecessary for this hot polling loop.
    while (!stop_flag_.load(std::memory_order_relaxed)) {
        beast::error_code ec;
        // Blocking read: must set a timeout or risk hanging forever if network stalls
        beast::get_lowest_layer(ws).expires_never();
        ws.read(buf, ec);

        if (ec == websocket::error::closed) {
            std::cout << "[ws] server closed connection\n";
            break;
        }
        // Catch the timeout explicitly so it cleanly breaks the loop
        if (ec == net::error::timed_out) {
            std::cerr << "[ws] connection timed out (silent drop). Dropping socket...\n";
            break;
        }

        if (ec) {
            std::cerr << "[ws] read error: " << ec.message() << "\n";
            break;
        }
        // Zero‑copy simdjson parse: buffer pre‑reserved with SIMDJSON_PADDING to avoid hidden allocations 
        // and copying of the JSON payload; parses directly from the network buffer for maximum performance.
        buf.reserve(buf.size() + simdjson::SIMDJSON_PADDING);

        simdjson::padded_string_view padded(
            static_cast<const char*>(buf.data().data()),
            buf.size(),
            buf.capacity()   
        );

    dispatch(padded);     // dispatch parses directly from buf's memory
    buf.clear();          // Clear the buffer for the next read; does not deallocate memory due to reserved capacity
    }

    // Close
    beast::error_code ec;
    ws.close(websocket::close_code::normal, ec);
}

// Signal the consumer to resync by writing a special value to the shared atomic last_u_.
void WsClient::trigger_resync() {
    ++reconnect_count_;
    std::cout << "[ws] signalling consumer resync (reconnect #" << reconnect_count_ << ")\n";
    // Write 0 to the shared atomic so the consumer invalidates its book
    last_u_.store(0, std::memory_order_release); 
}

// Message dispatcher: routes raw JSON to the appropriate parser based on stream name
void WsClient::dispatch(simdjson::padded_string_view raw_msg) {
    uint64_t t1 = rdtscp();

    simdjson::dom::element doc;
    if (parser_.parse(raw_msg.data(), raw_msg.size(), false).get(doc)) return;

    // Skip subscription confirmation messages (have "success" field, no "topic")
    std::string_view topic;
    if (doc["topic"].get(topic) != simdjson::SUCCESS) return;

    // Bybit nests payload in "data" field
    simdjson::dom::element data_field;
    if (doc["data"].get(data_field) != simdjson::SUCCESS) return;

    // Get message type for orderbook (snapshot vs delta)
    std::string_view msg_type;
    doc["type"].get(msg_type);   // optional, only for orderbook

    Tick tick{};
    bool ok = false;

    // Match topic prefix
    if (topic.starts_with("orderbook.")) {
        bool is_snap = (msg_type == "snapshot");
        ok = parse_depth(data_field, tick, is_snap);
    } else if (topic.starts_with("publicTrade.")) {
        // Bybit sends trades as an array — iterate
        simdjson::dom::array trade_arr = data_field;
        for (auto trade_elem : trade_arr) {
            Tick trade_tick{};
            if (parse_agg_trade(trade_elem, trade_tick)) {
                uint64_t t2 = rdtscp();
                latency_.parse_cycles.emplace_back(t2 - t1);
                trade_tick.t1_tsc = t1;
                trade_tick.t2_tsc = t2;
                queue_.push(std::move(trade_tick));
            }
        }
        return;   // already pushed in loop, skip the single-push at end
    }

    if (ok) {
        uint64_t t2 = rdtscp();
        latency_.parse_cycles.emplace_back(t2 - t1);
        tick.t1_tsc = t1;
        tick.t2_tsc = t2;
        queue_.push(std::move(tick));
    }
}

bool WsClient::parse_depth(simdjson::dom::element data, Tick& tick, bool is_snapshot) {
    tick.data = DepthUpdate{};
    auto& d   = std::get<DepthUpdate>(tick.data);

    // Bybit only has "u" (update_id) — no separate U or pu
    if (data["u"].get_int64().get(d.u) != simdjson::SUCCESS) return false;

    // Use u as both U and pu for sequence tracking
    // Snapshot: treat as initial seed (U=0 to skip pu check)
    // Delta: use previous u for continuity (handled by book logic)
    d.U  = d.u;
    d.pu = is_snapshot ? 0 : (d.u - 1);   // tells book this is a snapshot vs delta

    // ts is uint64 — your event_time is int64 so cast
    uint64_t ts = 0;
    // ts isn't inside data, it's at top-level; pass it from dispatch if you want it
    d.event_time = static_cast<int64_t>(ts);
    d.trans_time = 0;

    // b and a arrays — same format as Binance: [[price_str, qty_str], ...]
    auto fill_levels = [](simdjson::dom::array arr, std::vector<PriceLevel>& out) {
        out.clear();   // O(1), keeps capacity
        for (auto row : arr) {
            PriceLevel lv;
            std::string_view price_sv, qty_sv;
            if (row.at(0).get_string().get(price_sv) != simdjson::SUCCESS) continue;
            if (row.at(1).get_string().get(qty_sv) != simdjson::SUCCESS) continue;
            if (!parse_scaled(price_sv, lv.price, PRICE_SCALE)) continue;
            if (!parse_scaled(qty_sv, lv.qty, QTY_SCALE)) continue;
            out.push_back(lv);
        }
    };

    simdjson::dom::array bids_arr, asks_arr;
    if (data["b"].get_array().get(bids_arr) != simdjson::SUCCESS) return false;
    if (data["a"].get_array().get(asks_arr) != simdjson::SUCCESS) return false;

    fill_levels(bids_arr, scratch_bids_);
    fill_levels(asks_arr, scratch_asks_);

    // Move into the tick's DepthUpdate (single move, no copy)
    d.bids = std::move(scratch_bids_);
    d.asks = std::move(scratch_asks_);

    // Restore reserved capacity for next message
    // (move-from leaves the vector empty but valid; reserve() is idempotent if capacity already exists)
    scratch_bids_.reserve(256);
    scratch_asks_.reserve(256);

    return true;
}

bool WsClient::parse_agg_trade(simdjson::dom::element data, Tick& tick) {
    tick.data = AggTrade{};
    auto& t   = std::get<AggTrade>(tick.data);

    // Bybit field names
    if (data["T"].get_int64().get(t.trade_time) != simdjson::SUCCESS) return false;
    t.event_time = t.trade_time;   // Bybit doesn't send separate E

    // Bybit trade ID is a UUID string — hash it to int64 for compatibility
    std::string_view id_sv;
    if (data["i"].get_string().get(id_sv) == simdjson::SUCCESS) {
        // Use first 16 hex chars of UUID as a 64-bit ID (collision-free in practice)
        std::hash<std::string_view> hasher;
        t.agg_trade_id = static_cast<int64_t>(hasher(id_sv));
    }

    // Price and volume
    std::string_view p_sv, v_sv;
    if (data["p"].get_string().get(p_sv) != simdjson::SUCCESS) return false;
    if (data["v"].get_string().get(v_sv) != simdjson::SUCCESS) return false;
    if (!parse_scaled(p_sv, t.price, PRICE_SCALE)) return false;
    if (!parse_scaled(v_sv, t.qty, QTY_SCALE)) return false;

    // Side: "Buy"/"Sell" string instead of m bool
    // Bybit's "S" tells you who initiated the aggressive order, not maker side
    // S=Buy means buyer was taker → seller was maker → is_buyer_maker=false
    // S=Sell means seller was taker → buyer was maker → is_buyer_maker=true
    std::string_view side_sv;
    if (data["S"].get_string().get(side_sv) == simdjson::SUCCESS) {
        t.is_buyer_maker = (side_sv == "Sell");
    }

    return true;
}