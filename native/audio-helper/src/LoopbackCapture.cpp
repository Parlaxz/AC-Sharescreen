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

// Define stream flags that may not be present in older SDK headers.
#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

namespace screenlink::audio {

namespace {

// Activation types and shared activation logic now in ProcessLoopbackActivator.h

// ── Helper: build a human-readable error string from HRESULT ──

std::string HresultToString(HRESULT hr) {
    char buf[32] = {};
    snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

// ── Helper: release a COM pointer if non-null, then null it out ──

template <typename T>
void SafeRelease(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
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
static constexpr uint16_t kCaptureBlockAlign = kCaptureChannels * (kCaptureBitsPerSample / 8); // 8
static constexpr uint32_t kCaptureAvgBytesPerSec = kCaptureSampleRate * kCaptureBlockAlign;   // 384000

static WAVEFORMATEX MakeCaptureFormat() {
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = kCaptureChannels;
    fmt.nSamplesPerSec = kCaptureSampleRate;
    fmt.wBitsPerSample = kCaptureBitsPerSample;
    fmt.nBlockAlign = kCaptureBlockAlign;
    fmt.nAvgBytesPerSec = kCaptureAvgBytesPerSec;
    fmt.cbSize = 0;
    return fmt;
}

} // anonymous namespace

// ── IsProcessLoopbackSupported ──

bool IsProcessLoopbackSupported() {
    auto osInfo = DetectWindowsVersion();
    if (!osInfo.succeeded) return false;

    // Documented-supported builds (>= 20348)
    if (osInfo.build >= kMinProcessLoopbackBuild) return true;

    // Experimental candidate builds (19041–20347): check runtime probe
    if (osInfo.build >= kExperimentalProcessLoopbackFloor) {
        auto probeResult = ProbeProcessLoopbackRuntime();
        return probeResult.succeeded;
    }

    return false;
}

// ── RunCaptureWithPacketCallback ──

CaptureResult RunCaptureWithPacketCallback(const CaptureConfig& config, PacketCallback onPacket) {
    CaptureResult result;

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

    IAudioClient* pAudioClient = ar.audioClient;
    IAudioCaptureClient* pCaptureClient = ar.captureClient;

    // 6. Start the audio engine
    hr = pAudioClient->Start();
    if (FAILED(hr)) {
        result.failureReason = "IAudioClient::Start failed: "
            + HresultToString(hr);
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);

        CoUninitialize();
        return result;
    }

    // 7. Set Pro Audio thread priority
    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // 8. Capture loop
    uint64_t framesCaptured = 0;
    uint64_t sequenceNumber = 0;
    auto startTime = std::chrono::steady_clock::now();
    auto duration = std::chrono::milliseconds(config.durationMs);
    bool infiniteDuration = (config.durationMs == 0);
    bool running = true;
    std::vector<float> floatBuffer;

    while (running) {
        // Check timeout (durationMs==0 means infinite — no timeout)
        if (!infiniteDuration) {
            auto elapsed = std::chrono::steady_clock::now() - startTime;
            if (elapsed >= duration) {
                break;
            }
        }

        // Get the next available packet
        UINT32 packetSize = 0;
        hr = pCaptureClient->GetNextPacketSize(&packetSize);
        if (FAILED(hr)) {
            break;
        }

        while (packetSize > 0) {
            BYTE* pData = nullptr;
            UINT32 numFramesAvailable = 0;
            DWORD flags = 0;
            UINT64 devicePosition = 0;
            UINT64 qpcPosition = 0;

            hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable,
                                           &flags, &devicePosition, &qpcPosition);
            if (FAILED(hr)) {
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
                    // Zero-fill silent frames to preserve timeline
                    floatBuffer.assign(totalSamples, 0.0f);
                    packet.isSilent = true;
                } else {
                    floatBuffer.assign(
                        reinterpret_cast<float*>(pData),
                        reinterpret_cast<float*>(pData) + totalSamples);
                }

                packet.frames = floatBuffer.data();
            }

            // Invoke callback — always called even for silent packets
            if (!onPacket(packet)) {
                running = false;
            }

            framesCaptured += numFramesAvailable;
            sequenceNumber++;

            pCaptureClient->ReleaseBuffer(numFramesAvailable);

            if (!running) break;

            // Check for more packets
            hr = pCaptureClient->GetNextPacketSize(&packetSize);
            if (FAILED(hr)) {
                running = false;
                break;
            }
        }

        // Brief sleep if no data available (avoid busy-wait)
        if (packetSize == 0 && running) {
            Sleep(1);
        }
    }

    // 9. Stop the engine
    pAudioClient->Stop();

    // Revert Pro Audio priority
    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    // Populate result
    result.framesCaptured = framesCaptured;
    result.bytesWritten = framesCaptured * kCaptureBlockAlign;
    result.succeeded = true;

    // 10. Cleanup COM objects
    SafeRelease(pCaptureClient);
    SafeRelease(pAudioClient);
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

    IAudioClient* pAudioClient = ar.audioClient;
    IAudioCaptureClient* pCaptureClient = ar.captureClient;

    WAVEFORMATEX captureFormat = MakeCaptureFormat();

    // 6. Open WAV writer with overwrite flag
    WavWriter writer;
    if (!writer.Open(result.outputPath, kCaptureSampleRate, kCaptureChannels,
                     kCaptureBitsPerSample, config.overwrite)) {
        result.failureReason = "Failed to open output WAV file: " + result.outputPath;
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);

        CoUninitialize();
        return result;
    }

    // 7. Start audio engine
    hr = pAudioClient->Start();
    if (FAILED(hr)) {
        result.failureReason = "IAudioClient::Start failed: "
            + HresultToString(hr);
        writer.Close();
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);

        CoUninitialize();
        return result;
    }

    // 8. Set Pro Audio thread priority
    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // 9. Capture loop writing frames to WAV
    uint64_t framesCaptured = 0;
    auto startTime = std::chrono::steady_clock::now();
    auto duration = std::chrono::milliseconds(config.durationMs);
    bool infiniteDuration = (config.durationMs == 0);
    bool running = true;
    std::vector<float> floatBuffer;

    while (running) {
        // Check timeout (durationMs==0 means infinite — no timeout)
        if (!infiniteDuration) {
            auto elapsed = std::chrono::steady_clock::now() - startTime;
            if (elapsed >= duration) {
                break;
            }
        }

        UINT32 packetSize = 0;
        hr = pCaptureClient->GetNextPacketSize(&packetSize);
        if (FAILED(hr)) break;

        while (packetSize > 0) {
            BYTE* pData = nullptr;
            UINT32 numFramesAvailable = 0;
            DWORD flags = 0;
            UINT64 devicePosition = 0;
            UINT64 qpcPosition = 0;

            hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable,
                                           &flags, &devicePosition, &qpcPosition);
            if (FAILED(hr)) {
                running = false;
                break;
            }

            if (numFramesAvailable > 0) {
                size_t totalSamples =
                    static_cast<size_t>(numFramesAvailable) * kCaptureChannels;

                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    // Zero-fill silent frames to preserve timeline
                    floatBuffer.assign(totalSamples, 0.0f);
                } else {
                    floatBuffer.assign(
                        reinterpret_cast<float*>(pData),
                        reinterpret_cast<float*>(pData) + totalSamples);
                }

                if (!writer.WriteFrames(floatBuffer.data(), numFramesAvailable)) {
                    running = false;
                    break;
                }

                framesCaptured += numFramesAvailable;
            }

            pCaptureClient->ReleaseBuffer(numFramesAvailable);

            if (!running) break;

            hr = pCaptureClient->GetNextPacketSize(&packetSize);
            if (FAILED(hr)) {
                running = false;
                break;
            }
        }

        if (packetSize == 0 && running) {
            Sleep(1);
        }
    }

    // 10. Stop and close WAV
    pAudioClient->Stop();

    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    writer.Close();

    // Populate result
    result.framesCaptured = framesCaptured;
    result.bytesWritten = framesCaptured * kCaptureBlockAlign;
    result.succeeded = true;

    // 11. Cleanup COM
    SafeRelease(pCaptureClient);
    SafeRelease(pAudioClient);

    CoUninitialize();

    return result;
}

} // namespace screenlink::audio
