cmake_minimum_required(VERSION 3.20)
project(L2DataCapture CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Force static linking of GCC and Standard C++ libraries
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -static-libgcc -static-libstdc++ -static")

# Fix Boost warning (MSYS2 uses legacy FindBoost)
cmake_policy(SET CMP0167 OLD)

# Windows socket version — Beast requires this
add_compile_definitions(_WIN32_WINNT=0x0601)

# Point cmake at MSYS2 MinGW64 sysroot so find_package works without env vars
list(PREPEND CMAKE_PREFIX_PATH "C:/msys64/mingw64")

# ── Dependencies ──────────────────────────────────────────────────────────────
find_package(Boost REQUIRED COMPONENTS system thread)
find_package(simdjson REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(ZLIB REQUIRED)

# ── Target ────────────────────────────────────────────────────────────────────
add_executable(L2DataCapture
    src/main.cpp
    src/order_book.cpp
    src/rest_client.cpp
    src/ws_client.cpp
)

target_include_directories(L2DataCapture PRIVATE include)

target_link_libraries(L2DataCapture PRIVATE
    Boost::system
    Boost::thread
    simdjson::simdjson
    OpenSSL::SSL
    OpenSSL::Crypto
    ZLIB::ZLIB
    ws2_32
    mswsock
)

target_compile_options(L2DataCapture PRIVATE -O3 -march=native -fno-omit-frame-pointer)
