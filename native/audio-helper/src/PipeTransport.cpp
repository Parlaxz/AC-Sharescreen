#include "PipeTransport.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstring>
#include <deque>
#include <system_error>
#include <vector>

// ── Helper: Create SECURITY_ATTRIBUTES restricted to current user only ──
namespace {

bool CreateCurrentUserSecurityAttributes(SECURITY_ATTRIBUTES& sa,
                                          std::vector<char>& secDescBuf,
                                          std::vector<char>& aclBuf) {
    // 1. Get the current process token
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        return false;
    }

    // 2. Get the user SID from the token
    DWORD tokenInfoLen = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &tokenInfoLen);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        CloseHandle(token);
        return false;
    }
    std::vector<char> tokenInfoBuf(tokenInfoLen);
    TOKEN_USER* tokenUser = reinterpret_cast<TOKEN_USER*>(tokenInfoBuf.data());
    if (!GetTokenInformation(token, TokenUser, tokenUser, tokenInfoLen, &tokenInfoLen)) {
        CloseHandle(token);
        return false;
    }
    CloseHandle(token);

    // 3. Build ACL with one ACE: ALLOW current user full access
    aclBuf.resize(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) +
                  GetLengthSid(tokenUser->User.Sid) - sizeof(DWORD));
    PACL acl = reinterpret_cast<PACL>(aclBuf.data());
    if (!InitializeAcl(acl, static_cast<DWORD>(aclBuf.size()), ACL_REVISION)) {
        return false;
    }
    if (!AddAccessAllowedAce(acl, ACL_REVISION, GENERIC_ALL, tokenUser->User.Sid)) {
        return false;
    }

    // 4. Initialize security descriptor
    secDescBuf.resize(SECURITY_DESCRIPTOR_MIN_LENGTH);
    PSECURITY_DESCRIPTOR sd = reinterpret_cast<PSECURITY_DESCRIPTOR>(secDescBuf.data());
    if (!InitializeSecurityDescriptor(sd, SECURITY_DESCRIPTOR_REVISION)) {
        return false;
    }
    if (!SetSecurityDescriptorDacl(sd, TRUE, acl, FALSE)) {
        return false;
    }

    // 5. Set up SECURITY_ATTRIBUTES
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;

    return true;
}

} // anonymous namespace

namespace screenlink::audio {

// ========================================================================
// PcmPacketQueue (mutex-based deque with drop-oldest)
// ========================================================================

PcmPacketQueue::PcmPacketQueue(size_t maxPackets)
    : maxPackets_(maxPackets > 0 ? maxPackets : 1)
{
}

void PcmPacketQueue::Push(PcmPacket packet) {
    std::lock_guard<std::mutex> lock(mutex_);

    // Age-based eviction: remove packets that exceed the hard age limit
    if (!queue_.empty()) {
        LARGE_INTEGER currentQpc;
        QueryPerformanceCounter(&currentQpc);

        while (!queue_.empty()) {
            const auto& oldest = queue_.front();
            if (oldest.header.qpcTimestamp == 0) break; // No timestamp, keep it
            uint64_t ageQpc = currentQpc.QuadPart > static_cast<LONGLONG>(oldest.header.qpcTimestamp)
                ? currentQpc.QuadPart - static_cast<LONGLONG>(oldest.header.qpcTimestamp)
                : 0;
            // Convert age to microseconds using qpcFrequency from the packet
            uint64_t ageUs = (oldest.header.qpcFrequency > 0)
                ? (ageQpc * 1000000) / oldest.header.qpcFrequency
                : 0;
            if (ageUs < kHardQueueAgeLimitUs) break; // Young enough, stop evicting
            queue_.pop_front();
            droppedCount_++;
        }
    }

    // Count-based eviction: remove oldest if at capacity
    while (queue_.size() >= maxPackets_) {
        queue_.pop_front();
        droppedCount_++;
    }

    // Push newest
    queue_.push_back(std::move(packet));
}

bool PcmPacketQueue::TryPop(PcmPacket& packet) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (queue_.empty()) return false;
    packet = std::move(queue_.front());
    queue_.pop_front();
    return true;
}

size_t PcmPacketQueue::Size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.size();
}

size_t PcmPacketQueue::MaxSize() const {
    return maxPackets_;
}

uint32_t PcmPacketQueue::DroppedCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return droppedCount_;
}

void PcmPacketQueue::Reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    queue_.clear();
    droppedCount_ = 0;
}

// ========================================================================
// ValidatePcmHeader
// ========================================================================

PcmHeaderParseResult ValidatePcmHeader(const PcmPacketHeader& header) {
    if (header.magic != kPcmMagic) {
        return {false, "invalid magic"};
    }
    if (header.headerSize != sizeof(PcmPacketHeader)) {
        return {false, "invalid header size"};
    }
    if (header.wireVersion != kPcmWireVersion) {
        return {false, "unsupported wire version"};
    }
    if (header.sampleRate == 0) {
        return {false, "sample rate cannot be zero"};
    }
    if (header.channels == 0) {
        return {false, "channels cannot be zero"};
    }
    if (header.sampleFormat != 0) {
        return {false, "unsupported sample format (only float32=0)"};
    }
    if (header.frameCount == 0) {
        return {false, "frame count cannot be zero"};
    }
    if (header.frameCount > kMaxPcmFramesPerPacket) {
        return {false, "frame count exceeds maximum"};
    }

    // Check payloadBytes against expected value with overflow guard
    const uint64_t expectedPayload =
        static_cast<uint64_t>(header.frameCount) *
        static_cast<uint64_t>(header.channels) *
        sizeof(float);

    if (expectedPayload > static_cast<uint64_t>(kMaxPcmFrameBytes)) {
        return {false, "payload size exceeds maximum (overflow check)"};
    }

    if (expectedPayload != header.payloadBytes) {
        return {false, "payloadBytes mismatch with frameCount*channels*sizeof(float)"};
    }

    if (header.payloadBytes > kMaxPcmFrameBytes) {
        return {false, "payloadBytes exceeds maximum frame bytes"};
    }

    return {true, {}};
}

// ========================================================================
// PcmPipeWriter
// ========================================================================

PcmPipeWriter::~PcmPipeWriter() {
    Stop();
}

bool PcmPipeWriter::Start(const std::string& pipeName, uint32_t expectedClientPid) {
    if (running_.load()) {
        return false; // already running
    }

    pipeName_ = pipeName;
    expectedClientPid_ = expectedClientPid;
    clientConnected_.store(false);

    {
        std::lock_guard<std::mutex> lock(mutex_);
        pipe_ = nullptr;
    }

    running_.store(true);
    thread_ = std::thread(&PcmPipeWriter::ThreadFunc, this);

    return true;
}

void PcmPipeWriter::Stop() {
    running_.store(false);

    // Cancel any pending I/O on the pipe to unblock the thread quickly.
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (pipe_ != nullptr) {
            HANDLE hPipe = static_cast<HANDLE>(pipe_);
            CancelIoEx(hPipe, nullptr);
        }
    }

    if (thread_.joinable()) {
        thread_.join();
    }

    // Ensure pipe is closed (ThreadFunc may have already done this).
    std::lock_guard<std::mutex> lock(mutex_);
    if (pipe_ != nullptr) {
        HANDLE hPipe = static_cast<HANDLE>(pipe_);
        CloseHandle(hPipe);
        pipe_ = nullptr;
    }
}

void PcmPipeWriter::ThreadFunc() {
    // ── 1. Create named pipe (server, write-only) ──

    // Security: restrict pipe access to current user only
    SECURITY_ATTRIBUTES sa = {};
    std::vector<char> secDescBuf;
    std::vector<char> aclBuf;
    LPSECURITY_ATTRIBUTES lpSa = nullptr;
    if (CreateCurrentUserSecurityAttributes(sa, secDescBuf, aclBuf)) {
        lpSa = &sa;
    }

    HANDLE hPipe = CreateNamedPipeA(
        pipeName_.c_str(),
        PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1,                     // max instances
        65536,                 // outbound buffer size = 64KB
        0,                     // inbound buffer size (not used)
        0,                     // default client timeout
        lpSa);                 // security attributes

    if (hPipe == INVALID_HANDLE_VALUE) {
        running_.store(false);
        return;
    }

    // Publish the handle under the mutex so Stop() can cancel I/O.
    {
        std::lock_guard<std::mutex> lock(mutex_);
        pipe_ = static_cast<void*>(hPipe);
    }

    // ── 2. ConnectNamedPipe with timeout ──
    HANDLE connectEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!connectEvent) {
        running_.store(false);
        CloseHandle(hPipe);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            pipe_ = nullptr;
        }
        return;
    }

    OVERLAPPED connectOv = {};
    connectOv.hEvent = connectEvent;

    BOOL connected = ConnectNamedPipe(hPipe, &connectOv);
    if (!connected) {
        const DWORD err = GetLastError();
        if (err == ERROR_IO_PENDING) {
            // Wait for connection with timeout
            DWORD waitResult = WaitForSingleObject(connectEvent, kConnectTimeoutMs);
            if (waitResult == WAIT_TIMEOUT) {
                CancelIo(hPipe);  // cancel the pending connect
                CloseHandle(connectEvent);
                running_.store(false);
                CloseHandle(hPipe);
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    pipe_ = nullptr;
                }
                return;
            }
            // I/O completed (or error)
            DWORD bytesTransferred = 0;
            if (!GetOverlappedResult(hPipe, &connectOv, &bytesTransferred, FALSE)) {
                // Connection failed
                CloseHandle(connectEvent);
                running_.store(false);
                CloseHandle(hPipe);
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    pipe_ = nullptr;
                }
                return;
            }
        } else if (err != ERROR_PIPE_CONNECTED) {
            // Unexpected error
            CloseHandle(connectEvent);
            running_.store(false);
            CloseHandle(hPipe);
            {
                std::lock_guard<std::mutex> lock(mutex_);
                pipe_ = nullptr;
            }
            return;
        }
        // ERROR_PIPE_CONNECTED means client connected before we called ConnectNamedPipe
    }
    // else: synchronous connection succeeded

    CloseHandle(connectEvent);

    // ── Verify client PID ──
    {
        ULONG clientPid = 0;
        if (GetNamedPipeClientProcessId(hPipe, &clientPid) && clientPid != 0 &&
            expectedClientPid_ != 0 && clientPid != expectedClientPid_) {
            // Wrong client — reject and exit
            CloseHandle(hPipe);
            {
                std::lock_guard<std::mutex> lock(mutex_);
                pipe_ = nullptr;
            }
            running_.store(false);
            return;
        }
    }

    // Signal that PCM pipe client is connected
    clientConnected_.store(true);

    // ── 3. Main loop: read from queue, write to pipe ──
    while (running_.load()) {
        PcmPacket packet;
        if (!queue_.TryPop(packet)) {
            // Queue empty — brief sleep then retry
            Sleep(1);
            continue;
        }

        // Write header
        DWORD bytesWritten = 0;
        OVERLAPPED writeOv = {};
        BOOL writeOk = WriteFile(
            hPipe,
            &packet.header,
            static_cast<DWORD>(sizeof(packet.header)),
            &bytesWritten,
            &writeOv);

        if (!writeOk) {
            const DWORD err = GetLastError();
            if (err == ERROR_IO_PENDING) {
                if (!GetOverlappedResult(hPipe, &writeOv, &bytesWritten, TRUE)) {
                    writeErrors_.fetch_add(1, std::memory_order_relaxed);
                    break;
                }
            } else {
                writeErrors_.fetch_add(1, std::memory_order_relaxed);
                break;
            }
        }

        if (bytesWritten != sizeof(packet.header)) {
            writeErrors_.fetch_add(1, std::memory_order_relaxed);
            break;
        }

        // Write payload (if any)
        if (!packet.payload.empty()) {
            DWORD payloadBytes = static_cast<DWORD>(
                packet.payload.size() * sizeof(float));
            bytesWritten = 0;
            OVERLAPPED payloadOv = {};

            writeOk = WriteFile(
                hPipe,
                packet.payload.data(),
                payloadBytes,
                &bytesWritten,
                &payloadOv);

            if (!writeOk) {
                const DWORD err = GetLastError();
                if (err == ERROR_IO_PENDING) {
                    if (!GetOverlappedResult(hPipe, &payloadOv, &bytesWritten, TRUE)) {
                        writeErrors_.fetch_add(1, std::memory_order_relaxed);
                        break;
                    }
                } else {
                    writeErrors_.fetch_add(1, std::memory_order_relaxed);
                    break;
                }
            }

            if (bytesWritten != payloadBytes) {
                writeErrors_.fetch_add(1, std::memory_order_relaxed);
                break;
            }
        }

        packetsWritten_.fetch_add(1, std::memory_order_relaxed);
    }

    // ── 4. Cleanup ──
    FlushFileBuffers(hPipe);
    CloseHandle(hPipe);

    {
        std::lock_guard<std::mutex> lock(mutex_);
        pipe_ = nullptr;
    }
}

} // namespace screenlink::audio
