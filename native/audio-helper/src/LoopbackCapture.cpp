#include "LoopbackCapture.h"
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

// ── COM GUID definitions (defined locally to avoid linker dependency on uuid.lib) ──

// BCDE0395-E52F-467C-8E3D-C4579291692E
static const GUID CLSID_MMDeviceEnumerator_ = {
    0xBCDE0395, 0xE52F, 0x467C, { 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x92, 0x69, 0x2E }
};

// A95664D2-9614-4F35-A746-DE8DB63617E6
static const GUID IID_IMMDeviceEnumerator_ = {
    0xA95664D2, 0x9614, 0x4F35, { 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6 }
};

// 1CB9AD4C-DBFA-4C32-B178-C2F568A703B2
static const GUID IID_IAudioClient_ = {
    0x1CB9AD4C, 0xDBFA, 0x4C32, { 0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2 }
};

// C8ADBD64-E71E-48A0-A4DE-185C395CD317
static const GUID IID_IAudioCaptureClient_ = {
    0xC8ADBD64, 0xE71E, 0x48A0, { 0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17 }
};

// 41D949AB-D986-43B2-8748-0BA6E6E2E78E
static const GUID IID_IActivateAudioInterfaceCompletionHandler_ = {
    0x41D949AB, 0xD986, 0x43B2, { 0x87, 0x48, 0x0B, 0xA6, 0xE6, 0xE2, 0xE7, 0x8E }
};

// ── Process-loopback types (declared locally to avoid WinRT/CX dependency) ──

enum class ProcessLoopbackMode : int32_t {
    Include = 0,
    Exclude = 1,
};

struct ProcessLoopbackParams {
    ProcessLoopbackMode mode;
    DWORD targetProcessId;
};

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
        if (riid == IID_IUnknown ||
            riid == IID_IActivateAudioInterfaceCompletionHandler_) {
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
            hr = pAudioInterface->QueryInterface(IID_IAudioClient_,
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

} // anonymous namespace

// ── IsProcessLoopbackSupported ──

bool IsProcessLoopbackSupported() {
    auto osInfo = DetectWindowsVersion();
    return osInfo.succeeded &&
           osInfo.build >= kMinProcessLoopbackBuild;
}

// ── RunCaptureWithCallback ──

CaptureResult RunCaptureWithCallback(const CaptureConfig& config, FrameCallback onFrames) {
    CaptureResult result;

    // 1. Check OS support
    if (!IsProcessLoopbackSupported()) {
        auto osInfo = DetectWindowsVersion();
        result.failureReason = "Process-loopback capture requires Windows build "
            + std::to_string(kMinProcessLoopbackBuild)
            + " or later (current build: "
            + std::to_string(osInfo.build) + ")";
        return result;
    }

    // 2. Initialize COM
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        result.failureReason = "CoInitializeEx failed: " + HresultToString(hr);
        return result;
    }

    // 3. Get IMMDeviceEnumerator
    IMMDeviceEnumerator* pEnumerator = nullptr;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL,
                          IID_IMMDeviceEnumerator_,
                          reinterpret_cast<void**>(&pEnumerator));
    if (FAILED(hr)) {
        result.failureReason = "CoCreateInstance(MMDeviceEnumerator) failed: "
            + HresultToString(hr);
        CoUninitialize();
        return result;
    }

    // 4. Get default render endpoint
    IMMDevice* pDevice = nullptr;
    hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    if (FAILED(hr)) {
        result.failureReason = "GetDefaultAudioEndpoint failed: "
            + HresultToString(hr);
        SafeRelease(pEnumerator);
        CoUninitialize();
        return result;
    }

    // 5. Get device ID string
    LPWSTR deviceId = nullptr;
    hr = pDevice->GetId(&deviceId);
    if (FAILED(hr)) {
        result.failureReason = "IMMDevice::GetId failed: "
            + HresultToString(hr);
        SafeRelease(pDevice);
        SafeRelease(pEnumerator);
        CoUninitialize();
        return result;
    }

    // 6. Prepare process-loopback parameter blob
    ProcessLoopbackParams loopbackParams;
    loopbackParams.mode = config.includeMode
        ? ProcessLoopbackMode::Include
        : ProcessLoopbackMode::Exclude;
    loopbackParams.targetProcessId = static_cast<DWORD>(config.targetPid);

    PROPVARIANT variant;
    PropVariantInit(&variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(loopbackParams);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&loopbackParams);

    // 7. Create activation handler and begin async activation
    CaptureActivationHandler* handler = new CaptureActivationHandler();

    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    hr = ActivateAudioInterfaceAsync(deviceId, IID_IAudioClient_,
                                      &variant, handler, &asyncOp);

    // Clean up resources that are no longer needed
    PropVariantClear(&variant);
    CoTaskMemFree(deviceId);
    SafeRelease(pDevice);
    SafeRelease(pEnumerator);

    if (FAILED(hr)) {
        result.failureReason = "ActivateAudioInterfaceAsync failed: "
            + HresultToString(hr);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 8. Wait for activation (up to 5 seconds)
    if (!handler->Wait(5000)) {
        result.failureReason = "Audio interface activation timed out";
        // Note: Cancel() requires a newer SDK; async operation completes on its own.
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 9. Retrieve the activated IAudioClient
    IAudioClient* pAudioClient = handler->GetAudioClient();
    HRESULT activateResult = handler->GetResult();
    if (FAILED(activateResult) || !pAudioClient) {
        result.failureReason = "Audio client activation failed (HRESULT: "
            + HresultToString(activateResult) + ")";
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // pAudioClient has been AddRef'd by the handler; we must Release it later.

    // 10. Get mix format to determine sample rate and channel count
    WAVEFORMATEXTENSIBLE* pMixFormat = nullptr;
    hr = pAudioClient->GetMixFormat(reinterpret_cast<WAVEFORMATEX**>(&pMixFormat));
    if (FAILED(hr) || !pMixFormat) {
        result.failureReason = "GetMixFormat failed: " + HresultToString(hr);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    uint32_t sampleRate = pMixFormat->Format.nSamplesPerSec;
    uint16_t channels = pMixFormat->Format.nChannels;

    // Build the capture format — always IEEE float32, using the mix format's
    // sample rate and channel count so the engine can support it.
    WAVEFORMATEX captureFormat = {};
    captureFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    captureFormat.nChannels = channels;
    captureFormat.nSamplesPerSec = sampleRate;
    captureFormat.wBitsPerSample = 32;
    captureFormat.nBlockAlign = static_cast<uint16_t>((channels * 32) / 8);
    captureFormat.nAvgBytesPerSec = sampleRate * captureFormat.nBlockAlign;
    captureFormat.cbSize = 0;

    CoTaskMemFree(pMixFormat);
    pMixFormat = nullptr;

    // 11. Initialize audio client in loopback shared mode
    REFERENCE_TIME bufferDuration = 100000; // 10 ms in 100-ns units
    hr = pAudioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                   AUDCLNT_STREAMFLAGS_LOOPBACK,
                                   bufferDuration, 0, &captureFormat, nullptr);
    if (FAILED(hr)) {
        result.failureReason = "IAudioClient::Initialize (loopback) failed: "
            + HresultToString(hr);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 12. Get the capture client
    IAudioCaptureClient* pCaptureClient = nullptr;
    hr = pAudioClient->GetService(IID_IAudioCaptureClient_,
                                   reinterpret_cast<void**>(&pCaptureClient));
    if (FAILED(hr) || !pCaptureClient) {
        result.failureReason = "GetService(IAudioCaptureClient) failed: "
            + HresultToString(hr);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 13. Start the audio engine
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

    // 14. Set Pro Audio thread priority
    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // 15. Capture loop
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

            hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable,
                                            &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                running = false;
                break;
            }

            if (numFramesAvailable > 0 && (flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0) {
                // Data is always float32 because we initialized with IEEE_FLOAT
                size_t totalSamples =
                    static_cast<size_t>(numFramesAvailable) * channels;
                floatBuffer.assign(
                    reinterpret_cast<float*>(pData),
                    reinterpret_cast<float*>(pData) + totalSamples);

                if (!onFrames(floatBuffer.data(), numFramesAvailable, channels)) {
                    running = false;
                }

                framesCaptured += numFramesAvailable;
            }

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

    // 16. Stop the engine
    pAudioClient->Stop();

    // Revert Pro Audio priority
    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    // Populate result
    result.framesCaptured = framesCaptured;
    result.bytesWritten = framesCaptured * captureFormat.nBlockAlign;
    result.succeeded = true;

    // 17. Cleanup COM objects
    SafeRelease(pCaptureClient);
    SafeRelease(pAudioClient);
    SafeRelease(asyncOp);
    SafeRelease(handler); // may delete handler
    CoUninitialize();

    return result;
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
        result.failureReason = "Process-loopback capture requires Windows build "
            + std::to_string(kMinProcessLoopbackBuild)
            + " or later (current build: "
            + std::to_string(osInfo.build) + ")";
        return result;
    }

    // 2. Initialize COM
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        result.failureReason = "CoInitializeEx failed: " + HresultToString(hr);
        return result;
    }

    // 3. Get device enumerator
    IMMDeviceEnumerator* pEnumerator = nullptr;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL,
                          IID_IMMDeviceEnumerator_,
                          reinterpret_cast<void**>(&pEnumerator));
    if (FAILED(hr)) {
        result.failureReason = "CoCreateInstance(MMDeviceEnumerator) failed: "
            + HresultToString(hr);
        CoUninitialize();
        return result;
    }

    // 4. Get default render endpoint
    IMMDevice* pDevice = nullptr;
    hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    if (FAILED(hr)) {
        result.failureReason = "GetDefaultAudioEndpoint failed: "
            + HresultToString(hr);
        SafeRelease(pEnumerator);
        CoUninitialize();
        return result;
    }

    // 5. Get device ID
    LPWSTR deviceId = nullptr;
    hr = pDevice->GetId(&deviceId);
    if (FAILED(hr)) {
        result.failureReason = "IMMDevice::GetId failed: "
            + HresultToString(hr);
        SafeRelease(pDevice);
        SafeRelease(pEnumerator);
        CoUninitialize();
        return result;
    }

    // 6. Prepare process-loopback params
    ProcessLoopbackParams loopbackParams;
    loopbackParams.mode = config.includeMode
        ? ProcessLoopbackMode::Include
        : ProcessLoopbackMode::Exclude;
    loopbackParams.targetProcessId = static_cast<DWORD>(config.targetPid);

    PROPVARIANT variant;
    PropVariantInit(&variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(loopbackParams);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&loopbackParams);

    // 7. Activate with process-loopback
    CaptureActivationHandler* handler = new CaptureActivationHandler();

    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    hr = ActivateAudioInterfaceAsync(deviceId, IID_IAudioClient_,
                                      &variant, handler, &asyncOp);

    PropVariantClear(&variant);
    CoTaskMemFree(deviceId);
    SafeRelease(pDevice);
    SafeRelease(pEnumerator);

    if (FAILED(hr)) {
        result.failureReason = "ActivateAudioInterfaceAsync failed: "
            + HresultToString(hr);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 8. Wait for activation
    if (!handler->Wait(5000)) {
        result.failureReason = "Audio interface activation timed out";
        // Note: Cancel() requires a newer SDK; async operation completes on its own.
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    IAudioClient* pAudioClient = handler->GetAudioClient();
    HRESULT activateResult = handler->GetResult();
    if (FAILED(activateResult) || !pAudioClient) {
        result.failureReason = "Audio client activation failed (HRESULT: "
            + HresultToString(activateResult) + ")";
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 9. Get mix format for sample rate and channel count
    WAVEFORMATEXTENSIBLE* pMixFormat = nullptr;
    hr = pAudioClient->GetMixFormat(reinterpret_cast<WAVEFORMATEX**>(&pMixFormat));
    if (FAILED(hr) || !pMixFormat) {
        result.failureReason = "GetMixFormat failed: " + HresultToString(hr);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    uint32_t sampleRate = pMixFormat->Format.nSamplesPerSec;
    uint16_t channels = pMixFormat->Format.nChannels;

    WAVEFORMATEX captureFormat = {};
    captureFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    captureFormat.nChannels = channels;
    captureFormat.nSamplesPerSec = sampleRate;
    captureFormat.wBitsPerSample = 32;
    captureFormat.nBlockAlign = static_cast<uint16_t>((channels * 32) / 8);
    captureFormat.nAvgBytesPerSec = sampleRate * captureFormat.nBlockAlign;
    captureFormat.cbSize = 0;

    CoTaskMemFree(pMixFormat);
    pMixFormat = nullptr;

    // 10. Initialize as loopback
    REFERENCE_TIME bufferDuration = 100000; // 10 ms
    hr = pAudioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                   AUDCLNT_STREAMFLAGS_LOOPBACK,
                                   bufferDuration, 0, &captureFormat, nullptr);
    if (FAILED(hr)) {
        result.failureReason = "IAudioClient::Initialize (loopback) failed: "
            + HresultToString(hr);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 11. Get capture client
    IAudioCaptureClient* pCaptureClient = nullptr;
    hr = pAudioClient->GetService(IID_IAudioCaptureClient_,
                                   reinterpret_cast<void**>(&pCaptureClient));
    if (FAILED(hr) || !pCaptureClient) {
        result.failureReason = "GetService(IAudioCaptureClient) failed: "
            + HresultToString(hr);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 12. Open WAV writer (now that we know the format)
    WavWriter writer;
    if (!writer.Open(result.outputPath, sampleRate, channels, 32)) {
        result.failureReason = "Failed to open output WAV file: " + result.outputPath;
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 13. Start audio engine
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

    // 14. Set Pro Audio priority
    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // 15. Capture loop writing frames to WAV
    uint64_t framesCaptured = 0;
    auto startTime = std::chrono::steady_clock::now();
    auto duration = std::chrono::milliseconds(config.durationMs);
    bool running = true;
    std::vector<float> floatBuffer;

    while (running) {
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

            hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable,
                                            &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                running = false;
                break;
            }

            if (numFramesAvailable > 0 && (flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0) {
                size_t totalSamples =
                    static_cast<size_t>(numFramesAvailable) * channels;
                floatBuffer.assign(
                    reinterpret_cast<float*>(pData),
                    reinterpret_cast<float*>(pData) + totalSamples);

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

    // 16. Stop and close WAV
    pAudioClient->Stop();

    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    writer.Close();

    // Populate result
    result.framesCaptured = framesCaptured;
    result.bytesWritten = framesCaptured * captureFormat.nBlockAlign;
    result.succeeded = true;

    // 17. Cleanup COM
    SafeRelease(pCaptureClient);
    SafeRelease(pAudioClient);
    SafeRelease(asyncOp);
    SafeRelease(handler);
    CoUninitialize();

    return result;
}

} // namespace screenlink::audio
