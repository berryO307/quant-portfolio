#pragma once
#include "live_histogram.hpp"
#include <atomic>
#include <thread>
#include <chrono>
#include <iostream>
#include <iomanip>
#include <sstream>

// Polls a LiveHistogram roughly once a second and renders a single, in-place
// (carriage-return-overwritten) progress line to stdout. This is deliberately
// the only thing that knows how to print — LiveHistogram exposes nothing but
// snapshot(), so a future consumer (e.g. a relay/web layer) can poll the same
// object the same way, without this class or LiveHistogram needing to change.
class TerminalProgressView {
public:
    explicit TerminalProgressView(const LiveHistogram& histogram,
                                   std::chrono::milliseconds interval = std::chrono::milliseconds(1000))
        : histogram_(histogram), interval_(interval), running_(true) {
        thread_ = std::thread([this]() { run(); });
    }

    ~TerminalProgressView() {
        running_.store(false, std::memory_order_release);
        if (thread_.joinable()) thread_.join();
        std::cout << "\n";   // leave the final progress line intact, move past it
    }

    TerminalProgressView(const TerminalProgressView&)            = delete;
    TerminalProgressView& operator=(const TerminalProgressView&) = delete;

private:
    static double to_us(uint64_t ns) { return static_cast<double>(ns) / 1000.0; }

    void run() {
        while (running_.load(std::memory_order_acquire)) {
            render();
            std::this_thread::sleep_for(interval_);
        }
        render();   // final render with the latest numbers before the process exits
    }

    void render() {
        LiveHistogram::Snapshot snap = histogram_.snapshot();
        std::ostringstream line;
        line << std::fixed << std::setprecision(1)
             << "\r[capture] n=" << snap.count
             << "  p50=" << to_us(snap.p50_ns) << "us"
             << "  p99=" << to_us(snap.p99_ns) << "us"
             << "  p99.9=" << to_us(snap.p999_ns) << "us"
             << "  max=" << to_us(snap.max_ns) << "us"
             << "     ";  // padding to blot out leftover chars from a longer previous line
        std::cout << line.str() << std::flush;
    }

    const LiveHistogram&      histogram_;
    std::chrono::milliseconds interval_;
    std::atomic<bool>         running_;
    std::thread               thread_;
};
