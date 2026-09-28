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
                                        std::atomic<uint64_t>& queue_overflow_dropped,
                                        std::string symbol,
                                        CoarseBookState* coarse_state,
                                        int coarse_nsigfigs)
    : queue_(queue), stop_flag_(stop_flag), latency_(latency), last_u_(last_u),
      queue_overflow_dropped_(queue_overflow_dropped), symbol_(std::move(symbol)),
      coarse_state_(coarse_state), coarse_nsigfigs_(coarse_nsigfigs) {
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
    } else if (channel_ == Channel::CoarseDepth) {
        // Same l2Book subscription as the real Depth channel, plus nSigFigs
        // — Hyperliquid's own coarser-rounded book, requested directly from
        // the exchange rather than approximated by bucketing an
        // already-narrow snapshot. See Channel::CoarseDepth's own comment.
        sub_msg = R"({"method":"subscribe","subscription":{"type":"l2Book","coin":")" + symbol_ +
                  R"(","nSigFigs":)" + std::to_string(coarse_nsigfigs_) + "}}";
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

    // WIRE FIELD ORDER MATTERS HERE. On-Demand is forward-only: reading fields
    // in the order they appear costs one pass, while reading them out of order
    // makes simdjson rewind and rescan, which silently gives back the entire
    // reason for using On-Demand. Captured live from Hyperliquid (61 frames):
    //
    //   top level      : channel, data
    //   l2Book data    : coin, time, levels        level element: px, sz, n
    //   trades element : coin, side, px, sz, time, hash, tid, users
    //
    // Every read below, and in parse_depth/parse_trade, follows those orders.
    // If Hyperliquid ever reorders its fields this keeps working — it just
    // gets slower, with no error, so treat a parse-stage regression as a
    // reason to re-capture and re-check the order rather than to look here.
    simdjson::ondemand::document doc;
    if (parser_.iterate(raw_msg).get(doc)) return;

    std::string_view channel;
    if (doc["channel"].get_string().get(channel) != simdjson::SUCCESS) return;

    simdjson::ondemand::value data_field;
    if (doc["data"].get(data_field) != simdjson::SUCCESS) return;

    // Deliberately bypasses everything below: no Tick, no queue_.push(),
    // no latency_.record(), no OrderBook involvement at all — this channel
    // exists purely to give the web UI's coarsest price buckets real data
    // to aggregate (see Channel::CoarseDepth's own comment), and must never
    // touch the structures the real trading pipeline owns. Handed off to
    // the consumer thread via coarse_state_ (a small mutex-guarded
    // "latest value" slot, not a queue — see coarse_book_state.hpp) since
    // that thread is the sole producer for the SPSC export ring and this
    // one runs on its own, separate connection/thread.
    if (channel_ == Channel::CoarseDepth) {
        if (channel != "l2Book" || !coarse_state_) return;
        simdjson::ondemand::array levels;
        if (data_field["levels"].get_array().get(levels) != simdjson::SUCCESS) return;

        auto fill = [](simdjson::ondemand::array arr, std::vector<PriceLevel>& out) -> bool {
            out.clear();
            for (auto row : arr) {
                std::string_view px_sv, sz_sv;
                if (row["px"].get_string().get(px_sv) != simdjson::SUCCESS) continue;
                if (row["sz"].get_string().get(sz_sv) != simdjson::SUCCESS) continue;
                PriceLevel lv;
                if (!parse_scaled(px_sv, lv.price, PRICE_SCALE)) continue;
                if (!parse_scaled(sz_sv, lv.qty, QTY_SCALE)) continue;
                out.push_back(lv);
            }
            return true;
        };

        std::vector<PriceLevel> bids, asks;
        int idx = 0;
        for (auto side_elem : levels) {
            simdjson::ondemand::array side_arr;
            if (side_elem.get_array().get(side_arr) != simdjson::SUCCESS) return;
            if (idx == 0) fill(side_arr, bids);
            else if (idx == 1) fill(side_arr, asks);
            ++idx;
        }
        if (idx < 2 || bids.empty() || asks.empty()) return;

        coarse_state_->update(std::move(bids), std::move(asks), rdtscp());
        return;
    }

    Tick tick{};
    bool ok = false;

    if (channel == "l2Book") {
        ok = parse_depth(data_field, tick);
    } else if (channel == "trades") {
        // Hyperliquid sends trades as an array, same as Bybit's publicTrade.
        // t1 is the frame's arrival stamp and is deliberately shared by
        // every trade below — they did all arrive in the same frame, so
        // each one's end-to-end latency genuinely starts there. "parse"
        // (t2 - t1) is therefore cumulative through this tick's position in
        // the frame, not this tick's own marginal cost alone — see Tick's
        // own comment in types.hpp for why that's an accepted simplification
        // rather than an oversight.
        simdjson::ondemand::array trade_arr;
        if (data_field.get_array().get(trade_arr) != simdjson::SUCCESS) return;
        // count_elements() must happen before iteration and rewinds the cursor
        // afterwards — see parser_'s declaration for why the cost is accepted.
        size_t n_trades = 0;
        if (trade_arr.count_elements().get(n_trades) != simdjson::SUCCESS) return;
        if (trade_arr.reset() != simdjson::SUCCESS) { /* reset() is best-effort */ }
        const uint16_t batch_size = static_cast<uint16_t>(n_trades);
        uint16_t idx = 0;
        for (auto trade_elem : trade_arr) {
            // This tick's own marginal parse work starts here, not at t1 —
            // t1 is the whole frame's arrival stamp, shared by every trade
            // in it. See types.hpp's Tick comment / Engineering_Notes.md
            // §11.6 for why the two must stay distinct.
            uint64_t t_parse_begin = rdtscp();
            simdjson::ondemand::value trade_val;
            if (trade_elem.get(trade_val) != simdjson::SUCCESS) { ++idx; continue; }
            Tick trade_tick{};
            if (parse_trade(trade_val, trade_tick)) {
                uint64_t t2 = rdtscp();
                // parse_cycles is NOT recorded here. LatencyStore::dump() zips the
                // four stage vectors by index, so they must be appended by one
                // thread, for the same tick, under the same filter. Recording parse
                // on this producer thread while the consumer records the other three
                // guarantees divergence: this thread parses ahead of the consumer,
                // still records for ticks the consumer drops on queue overflow, and
                // records for pre-seed ticks the consumer now skips. The timestamps
                // needed to compute this stage travel with the Tick (t1_tsc..t2_tsc),
                // so the consumer derives it there.
                trade_tick.t1_tsc            = t1;
                trade_tick.t_parse_begin_tsc = t_parse_begin;
                trade_tick.t2_tsc            = t2;
                trade_tick.batch_index       = idx;
                trade_tick.batch_size        = batch_size;
                // Return value checked: SpscRingBuffer<Tick,1024>::push()
                // returns false (drops the tick) when full, and until this
                // fix that return was discarded at both call sites in this
                // function — a silent, uninstrumented drop path with no
                // way to ever know it had fired.
                if (!queue_.push(std::move(trade_tick))) {
                    queue_overflow_dropped_.fetch_add(1, std::memory_order_relaxed);
                }
            }
            ++idx;
        }
        return;
    }

    if (ok) {
        // l2Book is one tick per frame, so batch_index/batch_size keep their
        // defaults (0 of 1), and there is no earlier sibling to wait
        // behind — t_parse_begin_tsc == t1_tsc, giving this tick a
        // correctly-zero in-frame-wait, same as §11.6 found live.
        uint64_t t2 = rdtscp();
        // See the batched-trade site above: parse_cycles is derived by the
        // consumer from t1_tsc..t2_tsc.
        tick.t1_tsc            = t1;
        tick.t_parse_begin_tsc = t1;
        tick.t2_tsc            = t2;
        if (!queue_.push(std::move(tick))) {
            queue_overflow_dropped_.fetch_add(1, std::memory_order_relaxed);
        }
    }
}

// data = { coin, levels: [ [WsLevel...], [WsLevel...] ], time }, each
// WsLevel = {"px": "...", "sz": "...", "n": <int>}. Always a full snapshot
// (see this file's header comment) — pu=0 unconditionally, u/U set from
// Hyperliquid's own message timestamp (epoch ms, monotonically increasing
// per coin) purely as a strictly-increasing marker for main.cpp's existing
// last_u bookkeeping, not a real sequence-continuity number.
bool HyperliquidAdapter::parse_depth(simdjson::ondemand::value data, Tick& tick) {
    tick.data = DepthUpdate{};
    auto& d   = std::get<DepthUpdate>(tick.data);

    int64_t time_ms = 0;
    if (data["time"].get_int64().get(time_ms) != simdjson::SUCCESS) return false;

    d.u  = time_ms;
    d.U  = time_ms;
    d.pu = 0;
    d.event_time = time_ms;
    d.trans_time = time_ms;

    // Level element wire order is px, sz, n — read px then sz, never backwards.
    auto fill_levels = [](simdjson::ondemand::array arr, std::vector<PriceLevel>& out) -> bool {
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
        return true;
    };

    simdjson::ondemand::array levels;
    if (data["levels"].get_array().get(levels) != simdjson::SUCCESS) return false;

    // Each side is filled DURING the walk of `levels`, not captured first and
    // filled afterwards. Under DOM the two inner arrays could be held and
    // re-read later; an On-Demand array is a cursor into a single forward pass,
    // so advancing to side 1 invalidates any handle still held on side 0.
    size_t idx = 0;
    for (auto side_elem : levels) {
        simdjson::ondemand::array side_arr;
        if (side_elem.get_array().get(side_arr) != simdjson::SUCCESS) return false;
        if (idx == 0)      { if (!fill_levels(side_arr, scratch_bids_)) return false; }
        else if (idx == 1) { if (!fill_levels(side_arr, scratch_asks_)) return false; }
        ++idx;
    }
    if (idx < 2) return false;

    // move + re-reserve, NOT fill-in-place. Looks like the scratch buffers
    // are pointless here (std::move steals the block, so the reserve below
    // is a fresh malloc each time), but the alternative is worse: `tick` is
    // a fresh stack local per dispatch and parse_depth assigns a fresh
    // DepthUpdate into it, so d.bids/d.asks start at capacity 0 — filling
    // them directly would grow 0->32 through ~6 reallocations per side
    // instead of the one this costs. Measured depth rate is ~0.19/s (2167
    // depth ticks in 11,655s), so one allocation per side here is ~0.4
    // allocs/sec and not a hot-path concern. Removing it entirely would
    // need the ring buffer to hand out a slot to fill in place, which is a
    // queue-API change, not a local one.
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
bool HyperliquidAdapter::parse_trade(simdjson::ondemand::value data, Tick& tick) {
    tick.data = AggTrade{};
    auto& t   = std::get<AggTrade>(tick.data);

    // READ ORDER IS LOAD-BEARING. The wire order of a trade element, captured
    // live, is: coin, side, px, sz, time, hash, tid, users. The reads below
    // follow it exactly (skipping coin, hash and users, which are not used).
    //
    // The previous DOM version read time, tid, px, sz, side — near worst-case
    // for a forward-only cursor, since every field after the first would send
    // simdjson backwards through the object. Under DOM that cost nothing
    // because the whole document was already materialised; under On-Demand it
    // would rewind and rescan per field and hand back the entire benefit.
    //
    // side first. Unlike the others this one is tolerated as missing (the
    // original treated a missing side as "not buyer maker" rather than as a
    // malformed trade), so it must not early-return.
    std::string_view side_sv;
    if (data["side"].get_string().get(side_sv) == simdjson::SUCCESS) {
        t.is_buyer_maker = (side_sv == "A");
    }

    std::string_view px_sv, sz_sv;
    if (data["px"].get_string().get(px_sv) != simdjson::SUCCESS) return false;
    if (data["sz"].get_string().get(sz_sv) != simdjson::SUCCESS) return false;

    int64_t time_ms = 0;
    if (data["time"].get_int64().get(time_ms) != simdjson::SUCCESS) return false;
    t.event_time = time_ms;
    t.trade_time = time_ms;

    // Hyperliquid's trade id is already a plain integer, unlike Bybit's
    // UUID string (no hashing needed).
    if (data["tid"].get_int64().get(t.agg_trade_id) != simdjson::SUCCESS) return false;

    // Conversions after the reads: parse_scaled touches no simdjson state, so
    // doing them here keeps the cursor moving strictly forward above.
    if (!parse_scaled(px_sv, t.price, PRICE_SCALE)) return false;
    if (!parse_scaled(sz_sv, t.qty, QTY_SCALE)) return false;

    return true;
}
