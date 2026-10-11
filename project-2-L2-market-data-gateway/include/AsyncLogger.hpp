#pragma once
#include <atomic>
#include <array>
#include <thread>
#include <string>
#include <cstdio>
#include <cstring>
#include "thread_utils.hpp" // idle_sleep

class AsyncLogger {
public:
    static constexpr size_t CAPACITY = 4096;  // must be power of 2

    struct Entry {
        char msg[256];
        size_t len;
    };

    AsyncLogger() : running_(true) {
        drain_thread_ = std::thread([this]() { drain(); });
    }

    ~AsyncLogger() {
        running_.store(false, std::memory_order_release);
        drain_thread_.join();
    }

    // Hot path: called from your tick/book update thread
    // Lock-free, wait-free on the happy path
    void log(const char* msg, size_t len) {
        size_t head = head_.load(std::memory_order_relaxed);
        size_t next = (head + 1) & (CAPACITY - 1);

        if (next == tail_.load(std::memory_order_acquire))
            return;  // buffer full, drop the log — never block the hot path

        Entry& e = buffer_[head];
        len = std::min(len, sizeof(e.msg) - 1);
        std::memcpy(e.msg, msg, len);
        e.msg[len] = '\0';
        e.len = len;

        head_.store(next, std::memory_order_release);
    }

    // Convenience: format and log
    template<typename... Args>
    void logf(const char* fmt, Args&&... args) {
        char buf[256];
        int n = std::snprintf(buf, sizeof(buf), fmt, std::forward<Args>(args)...);
        if (n > 0) log(buf, static_cast<size_t>(n));
    }

private:
    void drain() {
        while (running_.load(std::memory_order_acquire)) {
            size_t tail = tail_.load(std::memory_order_relaxed);
            while (tail != head_.load(std::memory_order_acquire)) {
                const Entry& e = buffer_[tail];
                std::fwrite(e.msg, 1, e.len, stderr);
                std::fputc('\n', stderr);
                tail = (tail + 1) & (CAPACITY - 1);
                tail_.store(tail, std::memory_order_release);
            }
            // Not sleep_for(100us): a no-op on this toolchain, so this would
            // spin a core whenever the logger is in use. See idle_sleep().
            idle_sleep(std::chrono::microseconds(100));
        }
    }

    alignas(64) std::atomic<size_t> head_{0};  // written by hot path
    alignas(64) std::atomic<size_t> tail_{0};  // written by drain thread
    std::array<Entry, CAPACITY> buffer_;
    std::atomic<bool> running_;
    std::thread drain_thread_;
};

// Global singleton — one logger for the whole process
inline AsyncLogger& logger() {
    static AsyncLogger instance;
    return instance;
}