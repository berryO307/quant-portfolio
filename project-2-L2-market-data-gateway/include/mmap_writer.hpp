#pragma once
#include <string>
#include <stdexcept>
#include <iostream>
#include <cstring> // For memset
#include "types.hpp" // For NormalizedTick

#ifdef _WIN32
#include <windows.h> // The core Windows API header
#else
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#endif

// CROSS PLATFORM MEMORY-MAPPED WRITER
// This class is OS-aware to support a standard local-to-production workflow.
// Development: When compiled on Windows (_WIN32), it utilizes the native Windows 
// API (CreateFileMapping) to allow for seamless local testing and iteration.
// Production: When compiled in a POSIX environment, the preprocessor automatically 
// swaps to native Linux syscalls (mmap/ftruncate) for deployment.
// The core architectural principle remains identical across both environments: 
// writing high-frequency tick data straight to mapped memory to completely 
// bypass the high latency of standard disk I/O operations.

class MmapWriter {
private:
    std::string path_;
    size_t capacity_;
    size_t write_offset_;
    size_t file_size_bytes_;
    
#ifdef _WIN32
    // Windows uses 'HANDLE' instead of Linux file descriptors (int fd_)
    HANDLE file_handle_;
    HANDLE map_handle_;
#else
    int fd_; // Linux equivalent of file_handle_
#endif
    void* mmapped_region_;
    NormalizedTick* base_ptr_;

    // MECHANICAL FIX: Force physical page allocation
    void warm_up() {
        if (!mmapped_region_) return;

        std::cout << "[MmapWriter] Warming up memory: Pre-faulting " 
                  << (file_size_bytes_ / 1024 / 1024) << " MB...\n";

        // 1. Pre-touch: Write zero to every page (4KB) to trigger hard page faults now
        // rather than during the trading loop.
        volatile char* ptr = static_cast<volatile char*>(mmapped_region_);
        for (size_t i = 0; i < file_size_bytes_; i += 4096) {
            ptr[i] = 0; 
        }

        // Tracks whether the lock actually succeeded, so the final message
        // below reports what really happened instead of unconditionally
        // claiming "Pages locked" — confirmed live on a 1GB cloud box that
        // mlock() genuinely fails here (ENOMEM, RLIMIT_MEMLOCK too low for
        // this ~600MB region without CAP_IPC_LOCK/root), and the log was
        // claiming success anyway. Pre-faulting (the touch loop above) still
        // happens either way — only the "stays resident, can't be swapped
        // out" guarantee depends on this succeeding.
        bool locked = false;
#ifdef _WIN32
        // Windows: Lock the virtual address space into physical RAM
        if (VirtualLock(mmapped_region_, file_size_bytes_)) {
            locked = true;
        } else {
            std::cerr << "[WARNING] VirtualLock failed. Error: " << GetLastError()
                      << ". Ensure Process Working Set size is sufficient.\n";
        }
#else
        // Linux: Lock memory to prevent swapping and set kernel hints
        if (mlock(mmapped_region_, file_size_bytes_) == 0) {
            locked = true;
        } else {
            std::perror("[WARNING] mlock failed (requires sudo or ulimit -l)");
        }

        // Hint: Expect sequential access, kernel should read-ahead if needed
        madvise(mmapped_region_, file_size_bytes_, MADV_SEQUENTIAL);
        // Hint: This memory is important, don't drop it from the cache
        madvise(mmapped_region_, file_size_bytes_, MADV_WILLNEED);
#endif
        if (locked) {
            std::cout << "[MmapWriter] Warm-up complete. Pages locked.\n";
        } else {
            std::cout << "[MmapWriter] Warm-up complete. Pages NOT locked (see WARNING "
                         "above) — this region can be swapped out under memory pressure.\n";
        }
    }

public:
    MmapWriter(const std::string& path, size_t capacity_records)
        : path_(path), capacity_(capacity_records), write_offset_(0),
#ifdef _WIN32
          file_handle_(INVALID_HANDLE_VALUE), map_handle_(NULL),
#else
          fd_(-1),
#endif
          mmapped_region_(nullptr), base_ptr_(nullptr) {

        file_size_bytes_ = capacity_ * sizeof(NormalizedTick);

#ifdef _WIN32
        file_handle_ = CreateFileA(path_.c_str(), GENERIC_READ | GENERIC_WRITE,
                                   FILE_SHARE_READ, NULL, CREATE_ALWAYS, 
                                   FILE_ATTRIBUTE_NORMAL, NULL);

        if (file_handle_ == INVALID_HANDLE_VALUE) 
            throw std::runtime_error("MmapWriter: Failed to create file " + path_);

        LARGE_INTEGER li;
        li.QuadPart = file_size_bytes_;
        SetFilePointerEx(file_handle_, li, NULL, FILE_BEGIN);
        SetEndOfFile(file_handle_); 

        map_handle_ = CreateFileMappingA(file_handle_, NULL, PAGE_READWRITE, 0, 0, NULL);
        if (map_handle_ == NULL) {
            CloseHandle(file_handle_);
            throw std::runtime_error("MmapWriter: CreateFileMapping failed.");
        }

        mmapped_region_ = MapViewOfFile(map_handle_, FILE_MAP_ALL_ACCESS, 0, 0, file_size_bytes_);
#else
        fd_ = open(path_.c_str(), O_RDWR | O_CREAT | O_TRUNC, 0666);
        if (fd_ == -1) throw std::runtime_error("MmapWriter: Failed to open " + path_);

        if (ftruncate(fd_, file_size_bytes_) == -1) {
            close(fd_);
            throw std::runtime_error("MmapWriter: ftruncate failed.");
        }

        mmapped_region_ = mmap(NULL, file_size_bytes_, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0);
#endif

        if (mmapped_region_ == nullptr || mmapped_region_ == (void*)-1)
            throw std::runtime_error("MmapWriter: Mapping failed.");

        base_ptr_ = static_cast<NormalizedTick*>(mmapped_region_);

        // CRITICAL: Call warm_up to fault the pages into RAM before the loop starts
        warm_up();
    }

    ~MmapWriter() {
#ifdef _WIN32
        if (mmapped_region_) {
            VirtualUnlock(mmapped_region_, file_size_bytes_); // Best effort
            UnmapViewOfFile(mmapped_region_);
        }
        if (map_handle_) CloseHandle(map_handle_);
        if (file_handle_ != INVALID_HANDLE_VALUE) CloseHandle(file_handle_);
#else
        if (mmapped_region_ && mmapped_region_ != (void*)-1) {
            munlock(mmapped_region_, file_size_bytes_);
            munmap(mmapped_region_, file_size_bytes_);
        }
        if (fd_ != -1) close(fd_);
#endif
    }

    inline bool write(const NormalizedTick& tick) {
        if (write_offset_ >= capacity_) return false;
        base_ptr_[write_offset_++] = tick;
        return true;
    }

    inline size_t tick_count() const { return write_offset_; }
};