// boost/asio.hpp must come before relay_push_client.hpp: it pulls in
// export_pipeline.hpp, which includes <windows.h> for GetCurrentProcessorNumber
// under _WIN32 — and Boost.Asio needs to be the one to include <winsock2.h>
// first, or plain <windows.h> drags in the legacy <winsock.h> ahead of it
// and Asio refuses to build ("WinSock.h has already been included").
#include <boost/asio.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>

#include "relay_push_client.hpp"

#include <algorithm>
#include <functional>
#include <iostream>
#include <memory>

namespace net       = boost::asio;
namespace beast     = boost::beast;
namespace websocket = beast::websocket;
using     tcp       = net::ip::tcp;

RelayPushClient::RelayPushClient(std::string host, std::string port, double cpu_ghz,
                                  std::optional<std::string> token)
    : host_(std::move(host)), port_(std::move(port)), cpu_ghz_(cpu_ghz),
      token_(std::move(token)), running_(true) {
    thread_ = std::thread([this]() { run(); });
}

RelayPushClient::~RelayPushClient() {
    running_.store(false, std::memory_order_release);
    if (thread_.joinable()) thread_.join();
}

bool RelayPushClient::push(const ExportRecord& rec) {
    if (ring_.push(rec)) return true;
    dropped_.fetch_add(1, std::memory_order_relaxed);
    return false;
}

// Reconnect-forever loop, same shape as HyperliquidAdapter::run(): try a
// connection, run it until it errors or stop is requested, back off and
// retry. A relay that's down at startup (very common in local dev — the
// gateway and relay are started independently) is not a fatal condition
// here, unlike the Hyperliquid feed being unreachable — this class's own
// stream of records is best-effort, not this process's primary job.
void RelayPushClient::run() {
    // Cold path: TLS/WebSocket sends and a blocking resolver call on
    // reconnect. Previously unpinned, so the OS could schedule it onto the
    // hot-path/canary cores — see thread_utils.hpp's pin_thread_off_hot_cores.
    pin_thread_off_hot_cores("relay_push");

    auto delay = RECONNECT_BASE_DELAY;

    while (running_.load(std::memory_order_acquire)) {
        try {
            connect_and_send();
            delay = RECONNECT_BASE_DELAY;
        } catch (const std::exception& e) {
            std::cerr << "[relay-push] connection error: " << e.what() << "\n";
        }

        if (!running_.load(std::memory_order_acquire)) break;

        // Sleep in short slices so a stop request doesn't have to wait out
        // the full backoff delay before shutdown can proceed.
        auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(delay);
        while (remaining.count() > 0 && running_.load(std::memory_order_acquire)) {
            auto slice = std::min(remaining, std::chrono::milliseconds(200));
            std::this_thread::sleep_for(slice);
            remaining -= slice;
        }
        delay = std::min(delay * RECONNECT_BACKOFF_MULT, RECONNECT_MAX_DELAY);
    }

    uint64_t d = dropped();
    if (d > 0) {
        std::cerr << "[relay-push] " << d << " records dropped total (relay unreachable/slow)\n";
    }
}

void RelayPushClient::connect_and_send() {
    net::io_context ioc;
    websocket::stream<beast::tcp_stream> ws{ioc};

    tcp::resolver resolver{ioc};
    auto results = resolver.resolve(host_, port_);

    beast::get_lowest_layer(ws).expires_after(std::chrono::seconds(10));
    beast::get_lowest_layer(ws).connect(results);

    ws.set_option(websocket::stream_base::decorator(
        [](websocket::request_type& req) {
            req.set(beast::http::field::user_agent, "l2-gateway-relay-push/1.0");
        }));

    beast::get_lowest_layer(ws).expires_after(std::chrono::seconds(10));
    ws.handshake(host_, "/ingest");

    // Hello handshake — same shape replay-gateway.mjs sends, validated by
    // relay/src/types.ts's isHelloMessage(). token is only meaningful when
    // the relay was started with INGEST_TOKEN set; omitted entirely
    // otherwise (the relay ignores the field when no token is configured).
    std::string hello = "{\"type\":\"hello\",\"cpu_ghz\":" + std::to_string(cpu_ghz_);
    if (token_) hello += ",\"token\":\"" + *token_ + "\"";
    hello += "}";
    beast::get_lowest_layer(ws).expires_after(std::chrono::seconds(10));
    ws.write(net::buffer(hello));

    // FIFTH CORRECTION: the async rewrite still opened with 416 reconnects
    // in one session, now with a DIFFERENT message -- "The socket was
    // closed due to a timeout" -- and, decisively, the SAME count on BOTH
    // BTC and xyz:CL (414 vs 416), completely independent of write volume
    // for the first time across five attempts. A race or a starvation bug
    // scales with activity; a fixed leftover timer does not -- that
    // equality is what a stale, still-armed deadline looks like.
    //
    // The three expires_after(10s) calls above (connect, handshake, this
    // hello write) each arm `tcp_stream`'s ONE deadline timer for that one
    // guarded call. Nothing ever told the stream that deadline was no
    // longer needed once the hello write completed -- so it stayed armed,
    // counting down from whenever it was LAST set, and fired on its own
    // roughly 10s later, closing the socket regardless of anything the
    // async read/write loop below was doing. expires_never() is exactly
    // Beast's documented way to say "no deadline governs this stream from
    // here on" -- the async loop below needs none of its own, since an
    // async operation's own completion (success or error) is what ends it,
    // not a synchronous call blocking indefinitely without one.
    beast::get_lowest_layer(ws).expires_never();

    std::cout << "[relay-push] connected to ws://" << host_ << ":" << port_ << "/ingest\n";

    // The relay pings this connection every 15s and terminates it after
    // ~45s without a pong (bybitIngestClient.ts's startHeartbeat()) -- real
    // liveness detection any real gateway client must answer. Beast only
    // processes/auto-answers a ping control frame while a read is actually
    // in flight.
    //
    // FOURTH CORRECTION (this round, and the last one): three earlier
    // shapes of this function were each tried live and each failed a
    // different way, all rooted in the same underlying fact -- Beast's
    // BLOCKING (synchronous) API does not actually support "one thread
    // reading, another writing, both promptly" the way its docs describe
    // for the ASYNCHRONOUS API:
    //
    // 1. Two threads (a dedicated reader + this writer), each independently
    //    calling `expires_after` on the SAME `tcp_stream`: races the
    //    stream's one shared deadline timer. Reconnects tracked WRITE
    //    frequency (BTC ~1/2.6s, xyz:CL ~1/16.5s on a comparable session --
    //    a 46x difference from write volume alone, not from anything
    //    resembling a fixed heartbeat interval).
    //
    // 2. One thread, short (200ms) polling read before each write batch:
    //    fixed the timer race, but a `tcp_stream` timeout on a BLOCKING
    //    call doesn't cancel gracefully the way an async timeout does --
    //    it closes the socket outright, since closing the descriptor is
    //    the only way to unblock an already-blocked syscall. Reconnects
    //    then tracked the relay's 15s PING interval almost exactly (8 in
    //    115s), consistent with a ping's auto-pong occasionally not
    //    finishing inside that narrow window.
    //
    // 3. One thread, ring drained and written FIRST every iteration, read
    //    only attempted once the ring goes empty: meant to stop writes
    //    waiting on a read, but for a write-heavy feed the ring rarely IF
    //    EVER goes empty, so the read was starved for long stretches --
    //    Beast can only auto-answer a ping while a read is in flight, so a
    //    starved read means every ping during a busy stretch goes
    //    unanswered. Reconnects got WORSE for BTC (102 in a similar
    //    window) and stayed clean for xyz:CL (1) -- write volume, not
    //    read-timeout width, was the actual variable all along.
    //
    // All three symptoms trace to the same root cause: blocking reads and
    // blocking writes on ONE `tcp_stream`, however carefully interleaved
    // or timed, cannot both be "promptly available" at once on a single
    // thread, and splitting them across two threads reintroduces the
    // shared-timer race from attempt 1. Beast's documented "one pending
    // read + one pending write concurrently" guarantee is written for the
    // ASYNCHRONOUS API specifically -- a pending async_read and a pending
    // async_write on one io_context genuinely coexist without either
    // blocking the other, with no shared-timer race (no `expires_after` at
    // all needed once connected) and no starvation (the read is always
    // re-armed immediately on completion, regardless of how busy the
    // writer is). This is that version -- io_context::run() below drives
    // both, on this same thread, until the connection ends.
    bool had_error = false;
    bool stopping  = false;
    bool write_in_flight = false;
    beast::flat_buffer discard;
    ExportRecord rec;

    std::function<void()> do_read;
    std::function<void()> try_write;

    // Keeps exactly one read pending at all times -- this alone is what
    // lets Beast auto-answer a ping the instant one arrives, independent of
    // how busy try_write below is. discard is never inspected: the relay
    // sends no application data on /ingest, only control frames.
    do_read = [&]() {
        discard.clear();
        ws.async_read(discard, [&](beast::error_code ec, std::size_t) {
            if (ec) {
                if (!stopping) {
                    std::cerr << "[relay-push] read error: " << ec.message() << std::endl;
                    had_error = true;
                }
                return; // do not re-arm -- ioc.run() drains remaining handlers and returns
            }
            do_read();
        });
    };

    // Drains the ring one record at a time, chaining the next write from
    // inside the previous one's completion -- never more than one
    // async_write in flight (Beast requires that), but with no artificial
    // pacing between records either.
    try_write = [&]() {
        if (write_in_flight || had_error || stopping) return;
        if (!ring_.pop(rec)) return;
        write_in_flight = true;
        // Kept alive by the shared_ptr captured into the completion handler
        // below -- net::buffer() only wraps a view, so the string itself
        // must outlive the async_write call, which the raw local `rec`
        // (about to be overwritten by the next pop) cannot guarantee.
        auto json = std::make_shared<std::string>(export_record_to_json(rec));
        ws.async_write(net::buffer(*json), [&, json](beast::error_code ec, std::size_t) {
            write_in_flight = false;
            if (ec) {
                if (!stopping) {
                    std::cerr << "[relay-push] write error: " << ec.message() << std::endl;
                    had_error = true;
                }
                return;
            }
            try_write(); // immediately attempt the next queued record, if any
        });
    };

    // Nothing else wakes this io_context when push() (called from a
    // DIFFERENT thread -- ColdPathExporter's drain thread) enqueues a new
    // record; a short repeating timer is what notices. Also where a clean
    // stop request is noticed and acted on.
    net::steady_timer poll_timer(ioc);
    std::function<void()> schedule_poll;
    schedule_poll = [&]() {
        if (stopping || had_error) return;
        try_write();
        if (!running_.load(std::memory_order_acquire)) {
            // Stop requested. Close immediately rather than waiting for the
            // read to complete on its own (which could be up to ~15s away,
            // the relay's own ping interval) -- closing the descriptor is
            // what makes the pending async_read above complete (with an
            // error do_read's handler already ignores, since `stopping` is
            // now true) so ioc.run() below can actually return promptly.
            // Trade-off, accepted deliberately: whatever is still sitting
            // in the ring at this exact instant is not flushed -- this path
            // is explicitly documented as best-effort/drop-tolerant (see
            // dropped_ and this class's own header comment), and a fast,
            // reliable shutdown matters far more here than the last few
            // already-near-real-time-stale records. An EARLIER version of
            // this function traded that the other way (a graceful final
            // flush) and, on the path where that graceful branch's own
            // condition was never true, sat fully resident for 14+ minutes
            // past its own logged "clean exit" before being killed by hand.
            stopping = true;
            beast::get_lowest_layer(ws).close();
            return;
        }
        poll_timer.expires_after(std::chrono::milliseconds(5));
        poll_timer.async_wait([&](beast::error_code) { schedule_poll(); });
    };

    do_read();
    schedule_poll();
    ioc.run(); // returns once nothing is pending -- do_read stopped re-arming
               // (error or stopping) and schedule_poll stopped rescheduling

    // Unconditionally — safe even if the stream is already closed above
    // (had_error, or the stopping path). Idempotent, and the only thing
    // that guarantees the socket is torn down on every exit from this
    // function, not just the ones that reach here by a particular path.
    beast::get_lowest_layer(ws).close();
}
