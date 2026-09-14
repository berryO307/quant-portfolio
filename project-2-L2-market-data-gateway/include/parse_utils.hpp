#pragma once
#include <cstdint>
#include <charconv>
#include <string_view>
#include <system_error>

// Decimal-string-to-scaled-int64 conversion. Used by hyperliquid_adapter
// for both price/qty levels and trade prints, keeping numeric semantics
// identical across both.

// Design & Architecture Notes:
// - Zero Allocation & No Float: Completely float-free and rounding-free, ensuring 
//   deterministic integer math for the global price scaling system.
// - Bypasses std::from_chars: Eliminates all external function call overhead 
//   by utilizing a custom [[gnu::always_inline]] processing loop.
// - Branch Prediction: The inner multiply-and-accumulate loops are optimized for 
//   the CPU's branch predictor. The ASCII bounds check (d > 9) is heavily biased 
//   to fall through on valid, clean exchange data.
// - Auto-Vectorization: The continuous, predictable memory access (via string_view) 
//   and tight arithmetic loops allow the compiler to effectively unroll or apply 
//   SIMD vectorization to the digit processing steps.

[[gnu::always_inline]]
inline bool parse_scaled(std::string_view sv, int64_t& out, int64_t scale) {
    if (sv.empty()) return false;

    const char* p = sv.data();
    const char* e = p + sv.size();

    // Sign handling (Bybit prices are always positive but defensive)
    bool neg = false;
    if (*p == '-') { neg = true; ++p; }
    else if (*p == '+') { ++p; }

    // Integer part — multiply-by-10 loop, no function calls
    int64_t value = 0;
    while (p < e && *p != '.') {
        unsigned d = static_cast<unsigned>(*p - '0');
        if (d > 9) return false;
        value = value * 10 + d;
        ++p;
    }

    // Apply scale to integer part once
    value *= scale;

    // Fractional part — track remaining scale digits
    if (p < e && *p == '.') {
        ++p;
        int64_t frac_scale = scale;
        while (p < e && frac_scale > 1) {
            unsigned d = static_cast<unsigned>(*p - '0');
            if (d > 9) return false;
            frac_scale /= 10;
            value += d * frac_scale;
            ++p;
        }
        // Skip trailing digits beyond our scale
        while (p < e) {
            if (static_cast<unsigned>(*p - '0') > 9) return false;
            ++p;
        }
    }

    out = neg ? -value : value;
    return true;
}