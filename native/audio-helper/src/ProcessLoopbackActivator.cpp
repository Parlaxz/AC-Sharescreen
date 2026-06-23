#include "ProcessLoopbackActivator.h"

#include <cstdio>

namespace screenlink::audio {

namespace {

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

static constexpr uint32_t kSampleRate = 48000;
static constexpr uint16_t kChannels = 2;
static constexpr uint16_t kBitsPerSample = 32;
static constexpr uint16_t kBlockAlign = kChannels * (kBitsPerSample / 8);

static WAVEFORMATEX MakeCaptureFormat() {
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = kChannels;
    fmt.nSamplesPerSec = kSampleRate;
    fmt.wBitsPerSample = kBitsPerSample;
    fmt.nBlockAlign = kBlockAlign;
    fmt.nAvgBytesPerSec = kSampleRate * kBlockAlign;
    fmt.cbSize = 0;
    return fmt;
}

template <typename T>
void SafeRelease(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
}

class ActivateCompletionHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    ActivateCompletionHandler() : refCount_(1) {
        event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }

    ~ActivateCompletionHandler() {
        if (event_) CloseHandle(event_);
    }

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

    STDMETHODIMP ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* activateOperation) override
    {
        HRESULT hr = S_OK;
        IUnknown* pAudioInterface = nullptr;

        hr = activateOperation->GetActivateResult(&result_, &pAudioInterface);
        if (SUCCEEDED(hr) && SUCCEEDED(result_) && pAudioInterface) {
            hr = pAudioInterface->QueryInterface(__uuidof(IAudioClient),
                                                   reinterpret_cast<void**>(&audioClient_));
            if (FAILED(hr)) result_ = hr;
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

static std::string HrToString(HRESULT hr) {
    char buf[32] = {};
    snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

} // anonymous namespace

// ── Shared activation entry point ──

AcActivationResult ActivateProcessLoopback(
    DWORD targetPid,
    AcLoopbackMode mode,
    DWORD timeoutMs)
{
    AcActivationResult result;

    // Build activation params
    AcActivationParams params{};
    params.activationType = AcActivationType::kProcessLoopback;
    params.processLoopbackParams.targetProcessId = targetPid;
    params.processLoopbackParams.processLoopbackMode = mode;

    PROPVARIANT variant;
    PropVariantInit(&variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(params);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ActivateCompletionHandler* handler = new ActivateCompletionHandler();

    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(
        kVirtualAudioDeviceProcessLoopback,
        __uuidof(IAudioClient),
        &variant,
        handler,
        &asyncOp);

    // PROPVARIANT blob points to stack memory — prevent PropVariantClear from freeing it
    variant.blob.pBlobData = nullptr;
    variant.vt = VT_EMPTY;

    if (FAILED(hr)) {
        result.failureReason = "ActivateAudioInterfaceAsync failed: " + HrToString(hr);
        SafeRelease(handler);
        return result;
    }

    if (!handler->Wait(timeoutMs)) {
        result.failureReason = "Audio interface activation timed out";
        SafeRelease(asyncOp);
        SafeRelease(handler);
        return result;
    }

    HRESULT activateResult = handler->GetResult();
    IAudioClient* audioClient = handler->GetAudioClient();
    if (FAILED(activateResult) || !audioClient) {
        result.failureReason = "Audio client activation failed (HRESULT: " + HrToString(activateResult) + ")";
        SafeRelease(asyncOp);
        SafeRelease(handler);
        return result;
    }

    // AddRef before returning (caller is responsible for Release)
    audioClient->AddRef();
    result.audioClient = audioClient;

    // Initialize audio client with standard format
    WAVEFORMATEX captureFormat = MakeCaptureFormat();
    REFERENCE_TIME bufferDuration = 100000; // 10 ms
    hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        bufferDuration,
        0,
        &captureFormat,
        nullptr);

    if (FAILED(hr)) {
        result.failureReason = "IAudioClient::Initialize failed: " + HrToString(hr);
        SafeRelease(result.audioClient);
        result.audioClient = nullptr;
        SafeRelease(asyncOp);
        SafeRelease(handler);
        return result;
    }

    // Get IAudioCaptureClient
    IAudioCaptureClient* captureClient = nullptr;
    hr = audioClient->GetService(__uuidof(IAudioCaptureClient),
                                  reinterpret_cast<void**>(&captureClient));
    if (FAILED(hr) || !captureClient) {
        result.failureReason = "GetService(IAudioCaptureClient) failed: " + HrToString(hr);
        SafeRelease(result.audioClient);
        result.audioClient = nullptr;
        SafeRelease(asyncOp);
        SafeRelease(handler);
        return result;
    }

    result.captureClient = captureClient;
    result.succeeded = true;

    // Clean up intermediate COM objects
    SafeRelease(asyncOp);
    SafeRelease(handler);

    return result;
}

} // namespace screenlink::audio
