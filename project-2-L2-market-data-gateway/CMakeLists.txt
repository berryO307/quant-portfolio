cmake_minimum_required(VERSION 3.20)
project(L2DataCapture CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Fix Boost warning (MSYS2 uses legacy FindBoost). CMP0167 itself didn't
# exist before CMake 3.30 -- setting an unknown policy is a hard configure
# error ("Policy is not known to this version of CMake"), not a no-op, so
# this must be gated. Confirmed live on Ubuntu 22.04's stock cmake (3.22.1):
# configure failed outright without this guard. Below 3.30, cmake_policy
# can't have this choice anyway -- its own pre-3.30 default already behaves
# like OLD, so there's nothing to set.
if(POLICY CMP0167)
    cmake_policy(SET CMP0167 OLD)
endif()

if(WIN32)
    # Force static linking of GCC and Standard C++ libraries — an MSYS2/MinGW
    # convention so the .exe doesn't depend on libstdc++-6.dll etc. being on
    # PATH. Deliberately NOT applied on Linux: a fully-static glibc build
    # (-static) breaks NSS-based DNS resolution (getaddrinfo), which
    # Boost.Asio's resolver needs to reach Hyperliquid's WS endpoint at all —
    # this is a well-known glibc static-linking footgun, not a style choice.
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -static-libgcc -static-libstdc++ -static")

    # Windows socket version — Beast requires this
    add_compile_definitions(_WIN32_WINNT=0x0601)

    # Point cmake at MSYS2 MinGW64 sysroot so find_package works without env vars
    list(PREPEND CMAKE_PREFIX_PATH "C:/msys64/mingw64")
endif()

# ── Dependencies ──────────────────────────────────────────────────────────────
# Boost.System has been header-only since Boost 1.69 and modern distro
# packages (Ubuntu 26.04 ships 1.90) don't install a boost_system CMake
# config package for it at all — only requesting it as a REQUIRED component
# on Linux fails configure outright ("Could not find a package configuration
# file... boost_system"), even though nothing actually needs to link against
# it. "thread" still ships a real compiled library and config package on
# both platforms, so it stays required everywhere.
if(WIN32)
    find_package(Boost REQUIRED COMPONENTS system thread)
else()
    find_package(Boost REQUIRED COMPONENTS thread)
endif()
find_package(simdjson REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(ZLIB REQUIRED)
find_package(Threads REQUIRED)

# ── Target ────────────────────────────────────────────────────────────────────
add_executable(L2DataCapture
    src/main.cpp
    src/order_book.cpp
    src/hyperliquid_adapter.cpp
    src/market_data_source_factory.cpp
    src/relay_push_client.cpp
)

target_include_directories(L2DataCapture PRIVATE include)

target_link_libraries(L2DataCapture PRIVATE
    Boost::thread
    simdjson::simdjson
    OpenSSL::SSL
    OpenSSL::Crypto
    ZLIB::ZLIB
    Threads::Threads
)

if(WIN32)
    # Boost::system: see the find_package comment above — a real linkable
    # target on MSYS2's Boost build, unlike modern header-only Linux Boost.
    # Winsock: no Linux equivalent, sockets are always available there.
    target_link_libraries(L2DataCapture PRIVATE Boost::system ws2_32 mswsock)
endif()

target_compile_options(L2DataCapture PRIVATE -O3 -march=native -fno-omit-frame-pointer)
