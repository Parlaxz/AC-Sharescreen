#include "LoopbackCapture.h"
#include "AudioCapabilities.h"
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

// ── Process-loopback activation types ──

enum class AudioClientActivationType : int32_t {
    kDefault = 0,
    kProcessLoopback = 1,
};

enum class ProcessLoopbackMode : int32_t {
    kIncludeTargetProcessTree = 0,
    kExcludeTargetProcessTree = 1,
};

struct AudioClientProcessLoopbackParams {
    DWORD targetProcessId;
    ProcessLoopbackMode processLoopbackMode;
};

// Flat layout suitable for direct use as a PROPVARIANT blob.
// ActivationType (int32) + targetProcessId (DWORD) + processLoopbackMode (int32) = 12 bytes.
struct AudioClientActivationParams {
    AudioClientActivationType activationType;
    AudioClientProcessLoopbackParams processLoopbackParams;
};

static_assert(sizeof(AudioClientActivationParams) == 12,
              "AudioClientActivationParams must be exactly 12 bytes");

// Virtual audio device path for process-loopback capture.
static const wchar_t kVirtualAudioDeviceProcessLoopback[] = L"VAD\\Process_Loopback";

// ── COM completion handler for async activation ──

class CaptureActivationHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    CaptureActivationHandler() : refCount_(1) {
        event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }

    ~CaptureActivationHandler() {
        if (event_) CloseHandle(event_);
    }

    // IUnknown methods
    STDMETHODIMP QueryInterface(REFIID riid, void** ppvObject) override {
        if (!ppvObject) return E_POINTER;
        *ppvObject = nullptr;
        if (riid == __uuidof(IUnknown) ||
            riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppvObject = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override {
        return InterlockedIncrement(&refCount_);
    }

    STDMETHODIMP_(ULONG) Release() override {
        ULONG ref = InterlockedDecrement(&refCount_);
        if (ref == 0) {
            delete this;
            return 0;
        }
        return ref;
    }

    // IActivateAudioInterfaceCompletionHandler
    STDMETHODIMP ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* activateOperation) override
    {
        HRESULT hr = S_OK;
        IUnknown* pAudioInterface = nullptr;

        hr = activateOperation->GetActivateResult(&result_, &pAudioInterface);
        if (SUCCEEDED(hr) && SUCCEEDED(result_) && pAudioInterface) {
            hr = pAudioInterface->QueryInterface(__uuidof(IAudioClient),
                                                   reinterpret_cast<void**>(&audioClient_));
            if (FAILED(hr)) {
                result_ = hr;
            }
        }

        if (pAudioInterface) pAudioInterface->Release();

        SetEvent(event_);
        return S_OK;
    }

    bool Wait(DWORD timeoutMs) {
        return WaitForSingleObject(event_, timeoutMs) == WAIT_OBJECT_0;
    }

    IAudioClient* GetAudioClient() const { return audioClient_; }
    HRESULT GetResult() const { return result_; }

private:
    LONG refCount_;
    HANDLE event_ = nullptr;
    HRESULT result_ = E_FAIL;
    IAudioClient* audioClient_ = nullptr;
};

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

// ── Shared activation logic for all capture functions ──
//
// Activates the process-loopback virtual device and returns an initialized
// IAudioClient and IAudioCaptureClient. Caller must CoUninitialize, release
// all COM pointers, and free |out_handler| via SafeRelease.

struct ActivationResult {
    bool succeeded = false;
    std::string failureReason;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    CaptureActivationHandler* handler = nullptr;
};

ActivationResult ActivateProcessLoopback(const CaptureConfig& config) {
    ActivationResult ar;

    // Build activation params for process-loopback
    AudioClientActivationParams params{};
    params.activationType = AudioClientActivationType::kProcessLoopback;
    params.processLoopbackParams.targetProcessId =
        static_cast<DWORD>(config.targetPid);
    params.processLoopbackParams.processLoopbackMode =
        config.includeMode
            ? ProcessLoopbackMode::kIncludeTargetProcessTree
            : ProcessLoopbackMode::kExcludeTargetProcessTree;

    PROPVARIANT variant;
    PropVariantInit(&variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(params);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    // Create activation handler and begin async activation
    ar.handler = new CaptureActivationHandler();

    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(
        kVirtualAudioDeviceProcessLoopback,
        __uuidof(IAudioClient),
        &variant,
        ar.handler,
        &asyncOp);

    PropVariantClear(&variant);

    if (FAILED(hr)) {
        ar.failureReason = "ActivateAudioInterfaceAsync failed: "
            + HresultToString(hr);
        SafeRelease(asyncOp);
        SafeRelease(ar.handler);
        return ar;
    }

    ar.asyncOp = asyncOp;

    // Wait for activation (up to 10 seconds)
    if (!ar.handler->Wait(10000)) {
        ar.failureReason = "Audio interface activation timed out";
        SafeRelease(asyncOp);
        SafeRelease(ar.handler);
        return ar;
    }

    // Retrieve the activated IAudioClient
    ar.audioClient = ar.handler->GetAudioClient();
    HRESULT activateResult = ar.handler->GetResult();
    if (FAILED(activateResult) || !ar.audioClient) {
        ar.failureReason = "Audio client activation failed (HRESULT: "
            + HresultToString(activateResult) + ")";
        SafeRelease(asyncOp);
        SafeRelease(ar.handler);
        return ar;
    }

    // Initialize audio client with fixed format and autoconvert flags.
    // Note: No AUDCLNT_STREAMFLAGS_LOOPBACK — process-loopback is implicit
    // in the virtual device path.
    WAVEFORMATEX captureFormat = MakeCaptureFormat();
    REFERENCE_TIME bufferDuration = 100000; // 10 ms in 100-ns units
    hr = ar.audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        bufferDuration,
        0,
        &captureFormat,
        nullptr);

    if (FAILED(hr)) {
        ar.failureReason = "IAudioClient::Initialize failed: "
            + HresultToString(hr);
        SafeRelease(ar.audioClient);
        SafeRelease(asyncOp);
        SafeRelease(ar.handler);
        return ar;
    }

    // Get the capture client
    hr = ar.audioClient->GetService(
        __uuidof(IAudioCaptureClient),
        reinterpret_cast<void**>(&ar.captureClient));

    if (FAILED(hr) || !ar.captureClient) {
        ar.failureReason = "GetService(IAudioCaptureClient) failed: "
            + HresultToString(hr);
        SafeRelease(ar.captureClient);
        SafeRelease(ar.audioClient);
        SafeRelease(asyncOp);
        SafeRelease(ar.handler);
        return ar;
    }

    ar.succeeded = true;
    return ar;
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
    ActivationResult ar = ActivateProcessLoopback(config);
    if (!ar.succeeded) {
        result.failureReason = std::move(ar.failureReason);
        CoUninitialize();
        return result;
    }

    IAudioClient* pAudioClient = ar.audioClient;
    IAudioCaptureClient* pCaptureClient = ar.captureClient;
    IActivateAudioInterfaceAsyncOperation* asyncOp = ar.asyncOp;
    CaptureActivationHandler* handler = ar.handler;

    // 6. Start the audio engine
    hr = pAudioClient->Start();
    if (FAILED(hr)) {
        result.failureReason = "IAudioClient::Start failed: "
            + HresultToString(hr);
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
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
    bool running = true;
    std::vector<float> floatBuffer;

    while (running) {
        // Check timeout
        auto elapsed = std::chrono::steady_clock::now() - startTime;
        if (elapsed >= duration) {
            break;
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
    SafeRelease(asyncOp);
    SafeRelease(handler); // may delete handler
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
    ActivationResult ar = ActivateProcessLoopback(config);
    if (!ar.succeeded) {
        result.failureReason = std::move(ar.failureReason);
        CoUninitialize();
        return result;
    }

    IAudioClient* pAudioClient = ar.audioClient;
    IAudioCaptureClient* pCaptureClient = ar.captureClient;
    IActivateAudioInterfaceAsyncOperation* asyncOp = ar.asyncOp;
    CaptureActivationHandler* handler = ar.handler;

    WAVEFORMATEX captureFormat = MakeCaptureFormat();

    // 6. Open WAV writer with overwrite flag
    WavWriter writer;
    if (!writer.Open(result.outputPath, kCaptureSampleRate, kCaptureChannels,
                     kCaptureBitsPerSample, config.overwrite)) {
        result.failureReason = "Failed to open output WAV file: " + result.outputPath;
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
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
        SafeRelease(asyncOp);
        SafeRelease(handler);
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
    bool running = true;
    std::vector<float> floatBuffer;

    while (running) {
        // Check timeout
        auto elapsed = std::chrono::steady_clock::now() - startTime;
        if (elapsed >= duration) {
            break;
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
    SafeRelease(asyncOp);
    SafeRelease(handler);
    CoUninitialize();

    return result;
}

} // namespace screenlink::audio
