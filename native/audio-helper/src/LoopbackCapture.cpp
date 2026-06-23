#include "LoopbackCapture.h"
#include "AudioCapabilities.h"
#include "ProcessLoopbackActivator.h"
#include "WavWriter.h"
#include "WindowsVersion.h"
#include "Protocol.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>

#include <string>
#include <chrono>
#include <thread>
#include <vector>
#include <system_error>

namespace screenlink::audio {

namespace {

// ── Helper: build a human-readable error string from HRESULT ──

std::string HresultToString(HRESULT hr) {
    char buf[32] = {};
    snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

// ── RAII wrapper for Win32 HANDLE ──

class AutoHandle {
public:
    explicit AutoHandle(HANDLE h) noexcept : handle_(h) {}
    ~AutoHandle() noexcept {
        if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
            CloseHandle(handle_);
        }
    }
    AutoHandle(const AutoHandle&) = delete;
    AutoHandle& operator=(const AutoHandle&) = delete;
    AutoHandle(AutoHandle&& other) noexcept : handle_(other.handle_) {
        other.handle_ = nullptr;
    }
    AutoHandle& operator=(AutoHandle&& other) noexcept {
        if (this != &other) {
            if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
                CloseHandle(handle_);
            }
            handle_ = other.handle_;
            other.handle_ = nullptr;
        }
        return *this;
    }
    HANDLE Get() const noexcept { return handle_; }
    bool IsValid() const noexcept {
        return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
    }

private:
    HANDLE handle_ = nullptr;
};

// ── Fixed capture format: 48 kHz, stereo, IEEE float32 ──

static constexpr uint32_t kCaptureSampleRate = 48000;
static constexpr uint16_t kCaptureChannels = 2;
static constexpr uint16_t kCaptureBitsPerSample = 32;
static constexpr uint16_t kCaptureBlockAlign = kCaptureChannels * (kCaptureBitsPerSample / 8);
static constexpr uint32_t kCaptureAvgBytesPerSec = kCaptureSampleRate * kCaptureBlockAlign;

// ── Capture exit reason for proper result reporting ──

enum class CaptureExitReason {
    NotStarted,
    StopRequested,
    DurationElapsed,
    PacketApiFailure,
    EventWaitFailed,
    DeviceInvalidated,
    CallbackRequestedStop
};

} // anonymous namespace

// ── IsProcessLoopbackSupported ──

bool IsProcessLoopbackSupported() {
    auto osInfo = DetectWindowsVersion();
    if (!osInfo.succeeded) return false;

    if (osInfo.build >= kMinProcessLoopbackBuild) return true;

    if (osInfo.build >= kExperimentalProcessLoopbackFloor) {
        auto probeResult = ProbeProcessLoopbackRuntime();
        return probeResult.succeeded;
    }

    return false;
}

// ── RunCaptureWithPacketCallback ──

CaptureResult RunCaptureWithPacketCallback(const CaptureConfig& config, PacketCallback onPacket,
                                           const CaptureLifecycleCallbacks& lifecycle) {
    CaptureResult result;
    CaptureExitReason exitReason = CaptureExitReason::NotStarted;

    // 1. Check OS support
    if (!IsProcessLoopbackSupported()) {
        auto osInfo = DetectWindowsVersion();
        auto probeResult = ProbeProcessLoopbackRuntime();
        if (osInfo.build >= kExperimentalProcessLoopbackFloor && osInfo.build < kMinProcessLoopbackBuild) {
            result.failureReason = "Process-loopback capture is experimentally available on build "
                + std::to_string(osInfo.build) + " but the runtime probe failed: "
                + probeResult.failureReason;
        } else {
            result.failureReason = "Process-loopback capture requires Windows build "
                + std::to_string(kMinProcessLoopbackBuild)
                + " or later (current build: "
                + std::to_string(osInfo.build) + ")";
        }
        return result;
    }

    // 2. Enforce duration cap
    if (config.durationMs > kMaxCaptureTestDurationMs) {
        result.failureReason = "Capture duration ("
            + std::to_string(config.durationMs)
            + " ms) exceeds maximum allowed ("
            + std::to_string(kMaxCaptureTestDurationMs) + " ms)";
        return result;
    }

    // 3. Validate PID creation time (if provided)
    if (config.expectedCreationTimeUtc100ns != 0) {
        AutoHandle processHandle(OpenProcess(PROCESS_QUERY_INFORMATION, FALSE,
                                             config.targetPid));
        if (!processHandle.IsValid()) {
            result.failureReason = "Failed to open target process (PID "
                + std::to_string(config.targetPid)
                + "): " + std::to_string(GetLastError());
            return result;
        }
        FILETIME createTime{}, exitTime{}, kernelTime{}, userTime{};
        if (!GetProcessTimes(processHandle.Get(), &createTime, &exitTime,
                             &kernelTime, &userTime)) {
            result.failureReason = "GetProcessTimes failed: "
                + std::to_string(GetLastError());
            return result;
        }
        uint64_t createTime100ns =
            (static_cast<uint64_t>(createTime.dwHighDateTime) << 32)
            | static_cast<uint64_t>(createTime.dwLowDateTime);
        if (createTime100ns != config.expectedCreationTimeUtc100ns) {
            result.failureReason = "Target process PID "
                + std::to_string(config.targetPid)
                + " has been recycled (creation time mismatch)";
            return result;
        }
    }

    // 4. Initialize COM (MTA required for process-loopback)
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        result.failureReason = "CoInitializeEx failed: " + HresultToString(hr);
        return result;
    }

    // 5. Activate process-loopback virtual device using production path
    //    (WRL agile handler, official SDK types, WAVEFORMATEXTENSIBLE, event-driven)
    auto ar = ActivateProcessLoopback(
        config.targetPid,
        config.includeMode ? AcLoopbackMode::kIncludeTargetProcessTree : AcLoopbackMode::kExcludeTargetProcessTree,
        5000);

    if (!ar.succeeded) {
        result.failureReason = std::move(ar.failureReason);
        CoUninitialize();
        return result;
    }

    // ar now owns audioClient, captureClient, and sampleReadyEvent.
    // They are valid as long as ar is in scope. Do NOT SafeRelease them.

    // Signal startup success immediately (before capture loop, before any packets).
    // This is the correct readiness point — the stream was created successfully.
    if (lifecycle.onReady) {
        CaptureReadyInfo readyInfo;
        readyInfo.targetPid = config.targetPid;
        readyInfo.loopbackMode = config.includeMode
            ? AcLoopbackMode::kIncludeTargetProcessTree
            : AcLoopbackMode::kExcludeTargetProcessTree;
        readyInfo.sampleRate = 48000;
        readyInfo.channelCount = 2;
        readyInfo.bitsPerSample = 32;
        readyInfo.bufferFrames = ar.bufferFrames;
        readyInfo.streamFlags =
            AUDCLNT_STREAMFLAGS_LOOPBACK |
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        readyInfo.threadId = GetCurrentThreadId();
        lifecycle.onReady(readyInfo);
    }

    // 6. Create stop event for signaling shutdown
    HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stopEvent) {
        CoUninitialize();
        result.failureReason = "Failed to create stop event";
        return result;
    }

    // 7. Set Pro Audio thread priority
    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // 8. Event-driven capture loop
    uint64_t framesCaptured = 0;
    uint64_t sequenceNumber = 0;
    auto startTime = std::chrono::steady_clock::now();
    auto duration = std::chrono::milliseconds(config.durationMs);
    bool infiniteDuration = (config.durationMs == 0);
    bool running = true;
    std::vector<float> floatBuffer;

    HANDLE waitHandles[2] = { stopEvent, ar.sampleReadyEvent };
    bool audioClientStarted = true;

    while (running) {
        // Check timeout (durationMs==0 means infinite)
        if (!infiniteDuration) {
            auto elapsed = std::chrono::steady_clock::now() - startTime;
            if (elapsed >= duration) {
                exitReason = CaptureExitReason::DurationElapsed;
                break;
            }
        }

        // Wait for either stop signal or sample-ready
        DWORD waitResult = WaitForMultipleObjects(
            2,
            waitHandles,
            FALSE,
            infiniteDuration ? INFINITE : duration.count() > 0 ? 10 : INFINITE);

        if (waitResult == WAIT_OBJECT_0) {
            // Stop event signaled
            exitReason = CaptureExitReason::StopRequested;
            break;
        }

        if (waitResult == WAIT_OBJECT_0 + 1) {
            // Sample-ready: drain all available packets
            while (running) {
                UINT32 packetSize = 0;
                hr = ar.captureClient->GetNextPacketSize(&packetSize);
                if (FAILED(hr)) {
                    exitReason = CaptureExitReason::PacketApiFailure;
                    running = false;
                    break;
                }

                if (packetSize == 0) break;

                BYTE* pData = nullptr;
                UINT32 numFramesAvailable = 0;
                DWORD flags = 0;
                UINT64 devicePosition = 0;
                UINT64 qpcPosition = 0;

                hr = ar.captureClient->GetBuffer(&pData, &numFramesAvailable,
                                                  &flags, &devicePosition, &qpcPosition);
                if (FAILED(hr)) {
                    exitReason = CaptureExitReason::PacketApiFailure;
                    running = false;
                    break;
                }

                AudioPacket packet{};
                packet.frameCount = numFramesAvailable;
                packet.channels = kCaptureChannels;
                packet.sequenceNumber = sequenceNumber;
                packet.qpcPosition100ns = qpcPosition;
                packet.devicePosition = devicePosition;
                packet.isDiscontinuous =
                    (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0;
                packet.hasTimestampError =
                    (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0;

                if (numFramesAvailable > 0) {
                    size_t totalSamples =
                        static_cast<size_t>(numFramesAvailable) * kCaptureChannels;

                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        floatBuffer.assign(totalSamples, 0.0f);
                        packet.isSilent = true;
                    } else {
                        floatBuffer.assign(
                            reinterpret_cast<float*>(pData),
                            reinterpret_cast<float*>(pData) + totalSamples);
                    }

                    packet.frames = floatBuffer.data();
                }

                if (!onPacket(packet)) {
                    exitReason = CaptureExitReason::CallbackRequestedStop;
                    running = false;
                }

                framesCaptured += numFramesAvailable;
                sequenceNumber++;

                hr = ar.captureClient->ReleaseBuffer(numFramesAvailable);
                if (FAILED(hr)) {
                    exitReason = CaptureExitReason::PacketApiFailure;
                    running = false;
                    break;
                }

                if (!running) break;
            }
        } else if (waitResult == WAIT_TIMEOUT) {
            // Timeout on the wait -- check if duration expired
            continue;
        } else {
            // WAIT_FAILED or other
            exitReason = CaptureExitReason::EventWaitFailed;
            break;
        }
    }

    // 9. Stop the audio engine
    if (audioClientStarted && ar.audioClient) {
        hr = ar.audioClient->Stop();
        ar.stopHr = hr;
    }

    // Revert Pro Audio priority
    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    // 10. Cleanup stop event
    if (stopEvent) {
        CloseHandle(stopEvent);
    }

    // 11. Populate result
    result.framesCaptured = framesCaptured;
    result.bytesWritten = framesCaptured * kCaptureBlockAlign;

    // Set success only for expected exits
    if (exitReason == CaptureExitReason::StopRequested ||
        exitReason == CaptureExitReason::DurationElapsed ||
        exitReason == CaptureExitReason::CallbackRequestedStop) {
        result.succeeded = true;
    } else if (exitReason == CaptureExitReason::PacketApiFailure) {
        result.failureReason = "Capture API failure: " + HresultToString(hr);
    } else if (exitReason == CaptureExitReason::EventWaitFailed) {
        result.failureReason = "Event wait failed: " + HresultToString(hr);
    } else if (exitReason == CaptureExitReason::DeviceInvalidated) {
        result.failureReason = "Audio device invalidated";
    }

    // 12. Cleanup COM -- AcActivationResult destructor releases COM objects.
    // Must happen before CoUninitialize.
    // ar goes out of scope here, releasing audioClient, captureClient, sampleReadyEvent.

    CoUninitialize();

    return result;
}

// ── RunCaptureWithCallback (thin wrapper around RunCaptureWithPacketCallback) ──

CaptureResult RunCaptureWithCallback(const CaptureConfig& config, FrameCallback onFrames) {
    auto packetCallback = [&onFrames](const AudioPacket& packet) -> bool {
        return onFrames(packet.frames, packet.frameCount, packet.channels);
    };
    return RunCaptureWithPacketCallback(config, packetCallback);
}

// ── RunCapture (WAV output) ──

CaptureResult RunCapture(const CaptureConfig& config) {
    CaptureResult result;
    result.outputPath = config.outputPath;
    if (result.outputPath.empty()) {
        result.outputPath = "capture-" + std::to_string(config.targetPid) + ".wav";
    }

    // 1. Check OS support
    if (!IsProcessLoopbackSupported()) {
        auto osInfo = DetectWindowsVersion();
        auto probeResult = ProbeProcessLoopbackRuntime();
        if (osInfo.build >= kExperimentalProcessLoopbackFloor && osInfo.build < kMinProcessLoopbackBuild) {
            result.failureReason = "Process-loopback capture is experimentally available on build "
                + std::to_string(osInfo.build) + " but the runtime probe failed: "
                + probeResult.failureReason;
        } else {
            result.failureReason = "Process-loopback capture requires Windows build "
                + std::to_string(kMinProcessLoopbackBuild)
                + " or later (current build: "
                + std::to_string(osInfo.build) + ")";
        }
        return result;
    }

    // 2. Enforce duration cap
    if (config.durationMs > kMaxCaptureTestDurationMs) {
        result.failureReason = "Capture duration ("
            + std::to_string(config.durationMs)
            + " ms) exceeds maximum allowed ("
            + std::to_string(kMaxCaptureTestDurationMs) + " ms)";
        return result;
    }

    // 3. Validate PID creation time (if provided)
    if (config.expectedCreationTimeUtc100ns != 0) {
        AutoHandle processHandle(OpenProcess(PROCESS_QUERY_INFORMATION, FALSE,
                                             config.targetPid));
        if (!processHandle.IsValid()) {
            result.failureReason = "Failed to open target process (PID "
                + std::to_string(config.targetPid)
                + "): " + std::to_string(GetLastError());
            return result;
        }
        FILETIME createTime{}, exitTime{}, kernelTime{}, userTime{};
        if (!GetProcessTimes(processHandle.Get(), &createTime, &exitTime,
                             &kernelTime, &userTime)) {
            result.failureReason = "GetProcessTimes failed: "
                + std::to_string(GetLastError());
            return result;
        }
        uint64_t createTime100ns =
            (static_cast<uint64_t>(createTime.dwHighDateTime) << 32)
            | static_cast<uint64_t>(createTime.dwLowDateTime);
        if (createTime100ns != config.expectedCreationTimeUtc100ns) {
            result.failureReason = "Target process PID "
                + std::to_string(config.targetPid)
                + " has been recycled (creation time mismatch)";
            return result;
        }
    }

    // 4. Initialize COM
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        result.failureReason = "CoInitializeEx failed: " + HresultToString(hr);
        return result;
    }

    // 5. Activate process-loopback virtual device
    auto ar = ActivateProcessLoopback(
        config.targetPid,
        config.includeMode ? AcLoopbackMode::kIncludeTargetProcessTree : AcLoopbackMode::kExcludeTargetProcessTree,
        5000);
    if (!ar.succeeded) {
        result.failureReason = std::move(ar.failureReason);
        CoUninitialize();
        return result;
    }

    // ar now owns audioClient, captureClient, sampleReadyEvent.
    // Do NOT SafeRelease them.

    // 6. Open WAV writer with overwrite flag
    WavWriter writer;
    if (!writer.Open(result.outputPath, kCaptureSampleRate, kCaptureChannels,
                     kCaptureBitsPerSample, config.overwrite)) {
        result.failureReason = "Failed to open output WAV file: " + result.outputPath;
        CoUninitialize();
        return result;
    }

    // 7. Create stop event
    HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stopEvent) {
        writer.Close();
        CoUninitialize();
        result.failureReason = "Failed to create stop event";
        return result;
    }

    // 8. Set Pro Audio thread priority
    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // 9. Event-driven capture loop writing frames to WAV
    uint64_t framesCaptured = 0;
    auto startTime = std::chrono::steady_clock::now();
    auto duration = std::chrono::milliseconds(config.durationMs);
    bool infiniteDuration = (config.durationMs == 0);
    bool running = true;
    std::vector<float> floatBuffer;
    CaptureExitReason exitReason = CaptureExitReason::NotStarted;

    HANDLE waitHandles[2] = { stopEvent, ar.sampleReadyEvent };
    bool audioClientStarted = true;

    while (running) {
        if (!infiniteDuration) {
            auto elapsed = std::chrono::steady_clock::now() - startTime;
            if (elapsed >= duration) {
                exitReason = CaptureExitReason::DurationElapsed;
                break;
            }
        }

        DWORD waitResult = WaitForMultipleObjects(
            2,
            waitHandles,
            FALSE,
            infiniteDuration ? INFINITE : 10);

        if (waitResult == WAIT_OBJECT_0) {
            exitReason = CaptureExitReason::StopRequested;
            break;
        }

        if (waitResult == WAIT_OBJECT_0 + 1) {
            while (running) {
                UINT32 packetSize = 0;
                hr = ar.captureClient->GetNextPacketSize(&packetSize);
                if (FAILED(hr)) {
                    exitReason = CaptureExitReason::PacketApiFailure;
                    running = false;
                    break;
                }

                if (packetSize == 0) break;

                BYTE* pData = nullptr;
                UINT32 numFramesAvailable = 0;
                DWORD flags = 0;
                UINT64 devicePosition = 0;
                UINT64 qpcPosition = 0;

                hr = ar.captureClient->GetBuffer(&pData, &numFramesAvailable,
                                                  &flags, &devicePosition, &qpcPosition);
                if (FAILED(hr)) {
                    exitReason = CaptureExitReason::PacketApiFailure;
                    running = false;
                    break;
                }

                if (numFramesAvailable > 0) {
                    size_t totalSamples =
                        static_cast<size_t>(numFramesAvailable) * kCaptureChannels;

                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        floatBuffer.assign(totalSamples, 0.0f);
                    } else {
                        floatBuffer.assign(
                            reinterpret_cast<float*>(pData),
                            reinterpret_cast<float*>(pData) + totalSamples);
                    }

                    if (!writer.WriteFrames(floatBuffer.data(), numFramesAvailable)) {
                        exitReason = CaptureExitReason::CallbackRequestedStop;
                        running = false;
                        break;
                    }

                    framesCaptured += numFramesAvailable;
                }

                hr = ar.captureClient->ReleaseBuffer(numFramesAvailable);
                if (FAILED(hr)) {
                    exitReason = CaptureExitReason::PacketApiFailure;
                    running = false;
                    break;
                }

                if (!running) break;
            }
        } else if (waitResult == WAIT_TIMEOUT) {
            continue;
        } else {
            exitReason = CaptureExitReason::EventWaitFailed;
            break;
        }
    }

    // 10. Stop audio engine
    if (audioClientStarted && ar.audioClient) {
        hr = ar.audioClient->Stop();
        ar.stopHr = hr;
    }

    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    writer.Close();

    // 11. Cleanup stop event
    if (stopEvent) {
        CloseHandle(stopEvent);
    }

    // 12. Populate result
    result.framesCaptured = framesCaptured;
    result.bytesWritten = framesCaptured * kCaptureBlockAlign;

    if (exitReason == CaptureExitReason::StopRequested ||
        exitReason == CaptureExitReason::DurationElapsed ||
        exitReason == CaptureExitReason::CallbackRequestedStop) {
        result.succeeded = true;
    } else if (exitReason == CaptureExitReason::PacketApiFailure) {
        result.failureReason = "Capture API failure: " + HresultToString(hr);
    } else if (exitReason == CaptureExitReason::EventWaitFailed) {
        result.failureReason = "Event wait failed: " + HresultToString(hr);
    }

    // 13. Cleanup -- ar destructor releases COM objects before CoUninitialize
    CoUninitialize();

    return result;
}

} // namespace screenlink::audio
