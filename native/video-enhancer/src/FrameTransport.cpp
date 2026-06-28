#include "FrameTransport.h"
#include <stdexcept>
#include <vector>
#include <cstddef>

namespace screenlink::video {

// ─── Named pipe server ────────────────────────────────────────────────

static HANDLE CreatePipeServer(const std::string& pipeName) {
    // Build full pipe path
    std::string fullPath = "\\\\.\\pipe\\" + pipeName;

    HANDLE pipe = CreateNamedPipeA(
        fullPath.c_str(),
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
        1,                          // max instances (1 = single client)
        64 * 1024,                  // output buffer (64 KB)
        64 * 1024,                  // input buffer (64 KB)
        5000,                       // default timeout (ms)
        nullptr                     // default security attributes
    );

    if (pipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "[FrameTransport] Failed to create pipe '%s': %lu\n",
                fullPath.c_str(), GetLastError());
    }
    return pipe;
}

bool FrameTransport::CreateControlPipe(const std::string& name) {
    CloseControlPipe();
    controlPipe_ = CreatePipeServer(name);
    return controlPipe_ != INVALID_HANDLE_VALUE;
}

bool FrameTransport::CreateFramePipe(const std::string& name) {
    CloseFramePipe();
    framePipe_ = CreatePipeServer(name);
    return framePipe_ != INVALID_HANDLE_VALUE;
}

bool FrameTransport::WaitForClient(HANDLE pipe) {
    if (pipe == INVALID_HANDLE_VALUE) return false;

    BOOL connected = ConnectNamedPipe(pipe, nullptr);
    if (!connected) {
        DWORD err = GetLastError();
        if (err == ERROR_PIPE_CONNECTED) {
            // Client already connected between Create and Connect
            return true;
        }
        fprintf(stderr, "[FrameTransport] ConnectNamedPipe failed: %lu\n", err);
        return false;
    }
    return true;
}

HANDLE FrameTransport::GetControlPipe() const { return controlPipe_; }
HANDLE FrameTransport::GetFramePipe() const { return framePipe_; }

// ─── Read message (JSON) from control pipe ────────────────────────────

// Reads one message (terminated by '\n'). Returns empty string on error.
std::string FrameTransport::ReadControlMessage() {
    if (controlPipe_ == INVALID_HANDLE_VALUE) return {};

    std::string result;
    char buf[1024];
    DWORD bytesRead = 0;

    while (true) {
        BOOL ok = ReadFile(controlPipe_, buf, sizeof(buf) - 1, &bytesRead, nullptr);
        if (!ok) {
            DWORD err = GetLastError();
            if (err == ERROR_MORE_DATA) {
                // More data available — append and continue
                buf[bytesRead] = '\0';
                result.append(buf, bytesRead);
                continue;
            }
            // Pipe error or disconnected
            if (err != ERROR_BROKEN_PIPE && err != ERROR_PIPE_NOT_CONNECTED) {
                fprintf(stderr, "[FrameTransport] ReadFile error: %lu\n", err);
            }
            return {};
        }
        if (bytesRead == 0) return {}; // client disconnected

        buf[bytesRead] = '\0';
        result.append(buf, bytesRead);

        // Check for newline terminator
        if (result.find('\n') != std::string::npos) {
            // Trim at first newline
            result = result.substr(0, result.find('\n'));
            break;
        }

        // If we got fewer bytes than buffer but no newline, might still be complete
        if (bytesRead < sizeof(buf) - 1) {
            break;
        }
    }

    return result;
}

// ─── Write JSON response to control pipe ──────────────────────────────

bool FrameTransport::WriteControlResponse(const std::string& response) {
    if (controlPipe_ == INVALID_HANDLE_VALUE) return false;

    std::string framed = response + "\n";
    DWORD bytesWritten = 0;

    BOOL ok = WriteFile(controlPipe_, framed.data(),
                        static_cast<DWORD>(framed.size()),
                        &bytesWritten, nullptr);
    if (!ok) {
        fprintf(stderr, "[FrameTransport] WriteFile error: %lu\n", GetLastError());
        return false;
    }
    return bytesWritten == framed.size();
}

// ─── Exact I/O helpers (audit item 31) ──────────────────────────────

static bool ReadExact(HANDLE pipe, void* buf, size_t bytes) {
    if (bytes == 0) return true;
    size_t total = 0;
    auto* dst = static_cast<uint8_t*>(buf);
    while (total < bytes) {
        DWORD chunk = 0;
        DWORD toRead = static_cast<DWORD>((bytes - total) < (64 * 1024) ? (bytes - total) : (64 * 1024));
        BOOL ok = ReadFile(pipe, dst + total, toRead, &chunk, nullptr);
        if (!ok) {
            DWORD err = GetLastError();
            if (err == ERROR_MORE_DATA) {
                // Message-mode pipe with more data — count what we got and continue
                total += chunk;
                continue;
            }
            if (err != ERROR_BROKEN_PIPE) {
                fprintf(stderr, "[FrameTransport] ReadFile error: %lu\n", err);
            }
            return false;
        }
        if (chunk == 0) return false; // EOF before complete
        total += chunk;
    }
    return total == bytes;
}

static bool WriteAll(HANDLE pipe, const void* buf, size_t bytes) {
    if (bytes == 0) return true;
    size_t total = 0;
    auto* src = static_cast<const uint8_t*>(buf);
    while (total < bytes) {
        DWORD chunk = 0;
        DWORD toWrite = static_cast<DWORD>((bytes - total) < (64 * 1024) ? (bytes - total) : (64 * 1024));
        BOOL ok = WriteFile(pipe, src + total, toWrite, &chunk, nullptr);
        if (!ok) {
            fprintf(stderr, "[FrameTransport] WriteFile error: %lu\n", GetLastError());
            return false;
        }
        total += chunk;
    }
    return total == bytes;
}

// ─── Frame I/O (frame pipe, binary) ───────────────────────────────────

bool FrameTransport::ReadFrame(FrameHeader& header, std::vector<uint8_t>& data) {
    if (framePipe_ == INVALID_HANDLE_VALUE) return false;

    // Read header with partial-read resilience
    if (!ReadExact(framePipe_, &header, sizeof(header))) {
        fprintf(stderr, "[FrameTransport] Failed to read frame header\n");
        return false;
    }

    // Validate header (audit item 32)
    if (header.magic != 0x464C4156454D5246ULL) {
        fprintf(stderr, "[FrameTransport] Invalid frame header magic: 0x%llX\n",
                static_cast<unsigned long long>(header.magic));
        return false;
    }
    if (header.headerSize < sizeof(FrameHeader) || header.headerSize > 256) {
        fprintf(stderr, "[FrameTransport] Invalid header size: %u\n", header.headerSize);
        return false;
    }
    if (header.inputWidth == 0 || header.inputHeight == 0 ||
        header.inputWidth > kMaxFrameWidth || header.inputHeight > kMaxFrameHeight) {
        fprintf(stderr, "[FrameTransport] Invalid input dimensions: %ux%u\n",
                header.inputWidth, header.inputHeight);
        return false;
    }
    if (header.inputStride < header.inputWidth * 4) {
        fprintf(stderr, "[FrameTransport] Stride too small: %u < %u\n",
                header.inputStride, header.inputWidth * 4);
        return false;
    }
    if (header.payloadBytes > kMaxFrameSize) {
        fprintf(stderr, "[FrameTransport] Payload too large: %u > %u\n",
                header.payloadBytes, kMaxFrameSize);
        return false;
    }
    // Multiplication overflow check
    if (header.payloadBytes > 0 && header.payloadBytes / header.inputHeight < header.inputStride) {
        fprintf(stderr, "[FrameTransport] Payload mismatch: %u bytes, %u height, %u stride\n",
                header.payloadBytes, header.inputHeight, header.inputStride);
        return false;
    }

    // Read pixel data with partial-read resilience
    data.resize(header.payloadBytes);
    if (header.payloadBytes > 0 && !ReadExact(framePipe_, data.data(), header.payloadBytes)) {
        fprintf(stderr, "[FrameTransport] Failed to read frame data\n");
        return false;
    }

    return true;
}

bool FrameTransport::WriteFrame(const FrameHeader& header,
                                 const void* data, size_t dataSize) {
    if (framePipe_ == INVALID_HANDLE_VALUE) return false;

    // Write header with partial-write resilience
    if (!WriteAll(framePipe_, &header, sizeof(header))) {
        fprintf(stderr, "[FrameTransport] Failed to write frame header\n");
        return false;
    }

    // Write pixel data with partial-write resilience
    if (dataSize > 0 && !WriteAll(framePipe_, data, dataSize)) {
        fprintf(stderr, "[FrameTransport] Failed to write frame data\n");
        return false;
    }

    return true;
}

// ─── Close ────────────────────────────────────────────────────────────

void FrameTransport::CloseControlPipe() {
    if (controlPipe_ != INVALID_HANDLE_VALUE) {
        DisconnectNamedPipe(controlPipe_);
        CloseHandle(controlPipe_);
        controlPipe_ = INVALID_HANDLE_VALUE;
    }
}

void FrameTransport::CloseFramePipe() {
    if (framePipe_ != INVALID_HANDLE_VALUE) {
        DisconnectNamedPipe(framePipe_);
        CloseHandle(framePipe_);
        framePipe_ = INVALID_HANDLE_VALUE;
    }
}

} // namespace screenlink::video
