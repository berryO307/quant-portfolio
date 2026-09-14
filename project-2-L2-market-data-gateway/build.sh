#!/usr/bin/env bash
# build.sh — build quant_day1.exe using MSYS2 bash (avoids Windows TEMP issue)
# Usage: bash build.sh [clean]
set -e

export TEMP=/tmp
export TMP=/tmp
PATH=/c/msys64/mingw64/bin:$PATH

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"

mkdir -p "$BUILD/CMakeFiles/quant_day1.dir/src"

DEFINES="
  -DBOOST_ATOMIC_NO_LIB -DBOOST_ATOMIC_STATIC_LINK
  -DBOOST_DATE_TIME_NO_LIB -DBOOST_DATE_TIME_STATIC_LINK
  -DBOOST_THREAD_NO_LIB -DBOOST_THREAD_STATIC_LINK -DBOOST_THREAD_USE_LIB
  -DSIMDJSON_THREADS_ENABLED=1 -DSIMDJSON_USING_WINDOWS_DYNAMIC_LIBRARY=1
  -D_WIN32_WINNT=0x0A00"
INCS="-I$ROOT/include -IC:/msys64/mingw64/include"
FLAGS="-O2 -std=gnu++20 -Wall -Wextra"

OBJS=""
for f in main order_book rest_client ws_client; do
  OBJ="$BUILD/CMakeFiles/quant_day1.dir/src/$f.cpp.obj"
  echo "  CC  src/$f.cpp"
  c++ $DEFINES $INCS $FLAGS -c "$ROOT/src/$f.cpp" -o "$OBJ"
  OBJS="$OBJS $OBJ"
done

echo "  AR  objects.a"
# ar's `q` (quick append) does not replace existing members of an archive
# that's already there from a previous build — it appends alongside them,
# so a second run without a manual clean produced duplicate-symbol link
# errors for every single object file. Removing the stale archive first
# guarantees `ar qc` always builds a fresh one.
rm -f "$BUILD/CMakeFiles/quant_day1.dir/objects.a"
ar.exe qc "$BUILD/CMakeFiles/quant_day1.dir/objects.a" $OBJS

echo "  LD  quant_day1.exe"
c++.exe -O2 \
  -Wl,--whole-archive "$BUILD/CMakeFiles/quant_day1.dir/objects.a" -Wl,--no-whole-archive \
  -o "$BUILD/quant_day1.exe" \
  "C:/msys64/mingw64/lib/libboost_thread-mt.a" \
  C:/msys64/mingw64/lib/libsimdjson.dll.a \
  C:/msys64/mingw64/lib/libssl.dll.a \
  C:/msys64/mingw64/lib/libcrypto.dll.a \
  C:/msys64/mingw64/lib/libz.dll.a \
  -lws2_32 -lmswsock \
  "C:/msys64/mingw64/lib/libboost_atomic-mt.a" \
  -lsynchronization \
  "C:/msys64/mingw64/lib/libboost_chrono-mt.a" \
  "C:/msys64/mingw64/lib/libboost_date_time-mt.a" \
  "C:/msys64/mingw64/lib/libboost_container-mt.a" \
  -lkernel32 -luser32 -lgdi32 -lshell32 -lole32 -loleaut32 -luuid -ladvapi32

echo "  OK  build/quant_day1.exe"
