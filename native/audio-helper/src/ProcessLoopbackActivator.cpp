#include "ProcessLoopbackActivator.h"

#include <wrl.h>
#include <wrl/implements.h>

#include <ks.h>
#include <ksmedia.h>

#include <cstdio>
#include <mutex>

namespace screenlink::audio {

// ========================================================================
// WRL FtmBase completion handler -- agile, free-threaded marshalable
// ========================================================================

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

class ActivateCompletionHandler final :
    public RuntimeClass<
        RuntimeClassFlags<ClassicCom>,
        FtmBase,
        IActivateAudioInterfaceCompletionHandler>
{
public:
    ActivateCompletionHandler()
    {
        event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    }

    ~ActivateCompletionHandler()
    {
        if (event_ && event_ != INVALID_HANDLE_VALUE) {
            CloseHandle(event_);
        }
    }

    // IActivateAudioInterfaceCompletionHandler
    IFACEMETHOD(ActivateCompleted)(
        IActivateAudioInterfaceAsyncOperation* operation) override
    {
        HRESULT methodHr = E_POINTER;
        HRESULT activationHr = E_UNEXPECTED;
        ComPtr<IUnknown> activatedInterface;
        ComPtr<IAudioClient> client;

        if (operation != nullptr) {
            methodHr = operation->GetActivateResult(
                &activationHr,
                &activatedInterface);

            if (SUCCEEDED(methodHr) &&
                SUCCEEDED(activationHr) &&
                activatedInterface)
            {
                methodHr = activatedInterface.As(&client);
            }
        }

        {
            std::lock_guard<std::mutex> lock(resultMutex_);
            getActivateResultCallHr_ =
                (FAILED(methodHr) && activationHr == E_UNEXPECTED)
                    ? methodHr : S_OK;
            activationResultHr_ = activationHr;
            queryInterfaceHr_ = client ? S_OK :
                (SUCCEEDED(methodHr) ? E_NOINTERFACE : methodHr);
            audioClient_ = std::move(client);
        }

        if (event_ && event_ != INVALID_HANDLE_VALUE) {
            SetEvent(event_);
        }
        return S_OK;
    }

    bool IsValid() const noexcept
    {
        return event_ != nullptr && event_ != INVALID_HANDLE_VALUE;
    }

    DWORD Wait(DWORD timeoutMs) const noexcept
    {
        if (!event_ || event_ == INVALID_HANDLE_VALUE) {
            return WAIT_FAILED;
        }
        return WaitForSingleObject(event_, timeoutMs);
    }

    // Thread-safe accessors
    HRESULT GetActivateResultCallHr() const noexcept
    {
        std::lock_guard<std::mutex> lock(resultMutex_);
        return getActivateResultCallHr_;
    }

    HRESULT GetActivationResultHr() const noexcept
    {
        std::lock_guard<std::mutex> lock(resultMutex_);
        return activationResultHr_;
    }

    HRESULT GetQueryInterfaceHr() const noexcept
    {
        std::lock_guard<std::mutex> lock(resultMutex_);
        return queryInterfaceHr_;
    }

    HRESULT CopyAudioClient(IAudioClient** client) const noexcept
    {
        if (!client) return E_POINTER;
        std::lock_guard<std::mutex> lock(resultMutex_);
        if (!audioClient_) {
            *client = nullptr;
            return E_POINTER;
        }
        *client = audioClient_.Get();
        (*client)->AddRef();
        return S_OK;
    }

private:
    HANDLE event_ = nullptr;
    mutable std::mutex resultMutex_;

    HRESULT getActivateResultCallHr_ = E_UNEXPECTED;
    HRESULT activationResultHr_ = E_UNEXPECTED;
    HRESULT queryInterfaceHr_ = E_UNEXPECTED;
    ComPtr<IAudioClient> audioClient_;
};

// ========================================================================
// WAVEFORMATEXTENSIBLE builder
// ========================================================================

static constexpr uint32_t kSampleRate = 48000;
static constexpr uint16_t kChannels = 2;
static constexpr uint16_t kBitsPerSample = 32;
static constexpr uint16_t kBlockAlign = kChannels * (kBitsPerSample / 8);

static WAVEFORMATEXTENSIBLE MakeProcessLoopbackFormat()
{
    WAVEFORMATEXTENSIBLE fmt = {};

    fmt.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    fmt.Format.nChannels = kChannels;
    fmt.Format.nSamplesPerSec = kSampleRate;
    fmt.Format.wBitsPerSample = kBitsPerSample;
    fmt.Format.nBlockAlign = kBlockAlign;
    fmt.Format.nAvgBytesPerSec = kSampleRate * kBlockAlign;
    fmt.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);

    fmt.Samples.wValidBitsPerSample = kBitsPerSample;
    fmt.dwChannelMask = KSAUDIO_SPEAKER_STEREO;
    fmt.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;

    return fmt;
}

// ========================================================================
// Dynamic Mmdevapi.dll resolution
// ========================================================================

HMODULE GetMmdevapiModule()
{
    static HMODULE mod = []() -> HMODULE {
        HMODULE m = GetModuleHandleW(L"Mmdevapi.dll");
        if (!m) {
            m = LoadLibraryW(L"Mmdevapi.dll");
        }
        return m;
    }();
    return mod;
}

} // anonymous namespace

// ========================================================================
// ResolveActivateAudioInterfaceAsync
// ========================================================================

ActivateAudioInterfaceAsyncFn ResolveActivateAudioInterfaceAsync()
{
    static auto fn = []() -> ActivateAudioInterfaceAsyncFn {
        HMODULE mod = GetMmdevapiModule();
        if (!mod) return nullptr;
        return reinterpret_cast<ActivateAudioInterfaceAsyncFn>(
            GetProcAddress(mod, "ActivateAudioInterfaceAsync"));
    }();
    return fn;
}

// ========================================================================
// HRESULT helpers
// ========================================================================

const char* ActivationStageToString(AcActivationStage stage)
{
    switch (stage) {
        case AcActivationStage::NotStarted:           return "NotStarted";
        case AcActivationStage::ResolveApi:           return "ResolveApi";
        case AcActivationStage::ComInit:              return "ComInit";
        case AcActivationStage::CreateHandler:        return "CreateHandler";
        case AcActivationStage::BuildParameters:      return "BuildParameters";
        case AcActivationStage::ActivateCall:         return "ActivateCall";
        case AcActivationStage::WaitForCallback:      return "WaitForCallback";
        case AcActivationStage::GetActivateResult:    return "GetActivateResult";
        case AcActivationStage::QueryAudioClient:     return "QueryAudioClient";
        case AcActivationStage::InitializeAudioClient:return "InitializeAudioClient";
        case AcActivationStage::GetBufferSize:        return "GetBufferSize";
        case AcActivationStage::GetCaptureClient:     return "GetCaptureClient";
        case AcActivationStage::CreateSampleEvent:    return "CreateSampleEvent";
        case AcActivationStage::SetEventHandle:       return "SetEventHandle";
        case AcActivationStage::StartAudioClient:     return "StartAudioClient";
        case AcActivationStage::Ready:                return "Ready";
        case AcActivationStage::StopAudioClient:      return "StopAudioClient";
        case AcActivationStage::Cleanup:              return "Cleanup";
    }
    return "Unknown";
}

std::string HresultHex(HRESULT hr)
{
    char buf[32] = {};
    snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

const char* HresultSymbol(HRESULT hr)
{
    switch (hr) {
        case S_OK:                              return "S_OK";
        case S_FALSE:                           return "S_FALSE";
        case E_FAIL:                            return "E_FAIL";
        case E_POINTER:                         return "E_POINTER";
        case E_INVALIDARG:                      return "E_INVALIDARG";
        case E_NOINTERFACE:                     return "E_NOINTERFACE";
        case E_ILLEGAL_METHOD_CALL:             return "E_ILLEGAL_METHOD_CALL";
        case RPC_E_CHANGED_MODE:                return "RPC_E_CHANGED_MODE";
        case AUDCLNT_E_UNSUPPORTED_FORMAT:      return "AUDCLNT_E_UNSUPPORTED_FORMAT";
        case AUDCLNT_E_DEVICE_INVALIDATED:      return "AUDCLNT_E_DEVICE_INVALIDATED";
        case AUDCLNT_E_SERVICE_NOT_RUNNING:     return "AUDCLNT_E_SERVICE_NOT_RUNNING";
        case AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED: return "AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED";
        case AUDCLNT_E_EVENTHANDLE_NOT_EXPECTED: return "AUDCLNT_E_EVENTHANDLE_NOT_EXPECTED";
        case AUDCLNT_E_EVENTHANDLE_NOT_SET:     return "AUDCLNT_E_EVENTHANDLE_NOT_SET";
        case AUDCLNT_E_ALREADY_INITIALIZED:     return "AUDCLNT_E_ALREADY_INITIALIZED";
        default:
            if (hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) {
                return "HRESULT_FROM_WIN32(ERROR_NOT_FOUND)";
            }
            return nullptr;
    }
}

// ========================================================================
// AcActivationResult implementation
// ========================================================================

AcActivationResult::~AcActivationResult()
{
    Reset();
}

AcActivationResult::AcActivationResult(AcActivationResult&& other) noexcept
    : succeeded(other.succeeded)
    , stage(other.stage)
    , failureReason(std::move(other.failureReason))
    , comInitHr(other.comInitHr)
    , activateCallHr(other.activateCallHr)
    , getActivateResultCallHr(other.getActivateResultCallHr)
    , activationResultHr(other.activationResultHr)
    , queryAudioClientHr(other.queryAudioClientHr)
    , initializeHr(other.initializeHr)
    , getBufferSizeHr(other.getBufferSizeHr)
    , getCaptureClientHr(other.getCaptureClientHr)
    , createEventHr(other.createEventHr)
    , setEventHandleHr(other.setEventHandleHr)
    , startHr(other.startHr)
    , stopHr(other.stopHr)
    , audioClient(other.audioClient)
    , captureClient(other.captureClient)
    , bufferFrames(other.bufferFrames)
    , sampleReadyEvent(other.sampleReadyEvent)
{
    other.audioClient = nullptr;
    other.captureClient = nullptr;
    other.sampleReadyEvent = nullptr;
    other.bufferFrames = 0;
    other.succeeded = false;
    other.stage = AcActivationStage::NotStarted;
}

AcActivationResult& AcActivationResult::operator=(AcActivationResult&& other) noexcept
{
    if (this != &other) {
        Reset();
        succeeded = other.succeeded;
        stage = other.stage;
        failureReason = std::move(other.failureReason);
        comInitHr = other.comInitHr;
        activateCallHr = other.activateCallHr;
        getActivateResultCallHr = other.getActivateResultCallHr;
        activationResultHr = other.activationResultHr;
        queryAudioClientHr = other.queryAudioClientHr;
        initializeHr = other.initializeHr;
        getBufferSizeHr = other.getBufferSizeHr;
        getCaptureClientHr = other.getCaptureClientHr;
        createEventHr = other.createEventHr;
        setEventHandleHr = other.setEventHandleHr;
        startHr = other.startHr;
        stopHr = other.stopHr;
        audioClient = other.audioClient;
        captureClient = other.captureClient;
        bufferFrames = other.bufferFrames;
        sampleReadyEvent = other.sampleReadyEvent;
        other.audioClient = nullptr;
        other.captureClient = nullptr;
        other.sampleReadyEvent = nullptr;
        other.bufferFrames = 0;
        other.succeeded = false;
        other.stage = AcActivationStage::NotStarted;
    }
    return *this;
}

void AcActivationResult::Reset()
{
    if (audioClient) {
        audioClient->Release();
        audioClient = nullptr;
    }
    if (captureClient) {
        captureClient->Release();
        captureClient = nullptr;
    }
    if (sampleReadyEvent && sampleReadyEvent != INVALID_HANDLE_VALUE) {
        CloseHandle(sampleReadyEvent);
        sampleReadyEvent = nullptr;
    }
    bufferFrames = 0;
    succeeded = false;
    stage = AcActivationStage::NotStarted;
}

// ========================================================================
// ActivateProcessLoopback -- main activation entry point
//
// IMPORTANT: The caller must have COM initialized in MTA mode
// (CoInitializeEx(nullptr, COINIT_MULTITHREADED)) before calling this
// function. The returned COM pointers are only valid while the calling
// thread's COM remains initialized.
//
// This function does NOT call CoInitializeEx or CoUninitialize.
// ========================================================================

AcActivationResult ActivateProcessLoopback(
    DWORD targetPid,
    AcLoopbackMode mode,
    DWORD timeoutMs)
{
    AcActivationResult result;

    // ── Stage: ResolveApi ──
    result.stage = AcActivationStage::ResolveApi;
    ActivateAudioInterfaceAsyncFn activateFn = ResolveActivateAudioInterfaceAsync();
    if (!activateFn) {
        result.activateCallHr = HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
        result.failureReason = "ActivateAudioInterfaceAsync not found in Mmdevapi.dll";
        return result;
    }

    // ── Stage: CreateHandler (WRL FtmBase agile handler) ──
    result.stage = AcActivationStage::CreateHandler;
    ComPtr<ActivateCompletionHandler> handler;
    {
        HRESULT hr = MakeAndInitialize<ActivateCompletionHandler>(&handler);
        if (FAILED(hr) || !handler) {
            result.createEventHr = hr;
            result.failureReason = "Failed to create WRL completion handler";
            return result;
        }
        if (!handler->IsValid()) {
            result.createEventHr = HRESULT_FROM_WIN32(GetLastError());
            result.failureReason = "Completion handler event creation failed";
            return result;
        }
    }

    // ── Stage: BuildParameters ──
    result.stage = AcActivationStage::BuildParameters;

    // Use official AUDIOCLIENT_ACTIVATION_PARAMS from the Windows SDK.
    // This is NOT a custom ABI replica -- it's the real SDK structure.
    AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
    activationParams.ActivationType =
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId = targetPid;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
        (mode == AcLoopbackMode::kIncludeTargetProcessTree)
            ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
            : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT variant = {};
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(activationParams);
    variant.blob.pBlobData =
        reinterpret_cast<BYTE*>(&activationParams);

    // CRITICAL: Do NOT modify variant or activationParams between
    // the ActivateAudioInterfaceAsync call and the completion callback.
    // pBlobData points to stack memory owned by activationParams.
    // Do NOT call PropVariantClear on variant. Do NOT null pBlobData.
    // Do NOT change vt. Both objects must remain in scope until after
    // the async operation completes.

    ComPtr<IActivateAudioInterfaceAsyncOperation> asyncOp;

    // ── Stage: ActivateCall ──
    result.stage = AcActivationStage::ActivateCall;
    result.activateCallHr = activateFn(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &variant,
        handler.Get(),
        &asyncOp);

    // activationParams and variant must remain alive until handler->Wait returns.
    // Do NOT null pBlobData or change vt here.

    if (FAILED(result.activateCallHr)) {
        result.failureReason = std::string("ActivateAudioInterfaceAsync failed: ")
            + HresultHex(result.activateCallHr)
            + " (" + (HresultSymbol(result.activateCallHr) ? HresultSymbol(result.activateCallHr) : "") + ")";
        return result;
    }

    // ── Stage: WaitForCallback ──
    result.stage = AcActivationStage::WaitForCallback;
    DWORD waitResult = handler->Wait(timeoutMs);
    if (waitResult == WAIT_TIMEOUT) {
        result.failureReason = "Activation timed out after "
            + std::to_string(timeoutMs) + "ms";
        result.getActivateResultCallHr = E_FAIL;
        return result;
    }
    if (waitResult == WAIT_FAILED) {
        result.failureReason = "Wait for activation completion failed";
        result.getActivateResultCallHr = E_FAIL;
        return result;
    }

    // ── Stage: GetActivateResult ──
    result.stage = AcActivationStage::GetActivateResult;
    result.getActivateResultCallHr = handler->GetActivateResultCallHr();
    result.activationResultHr = handler->GetActivationResultHr();
    result.queryAudioClientHr = handler->GetQueryInterfaceHr();

    if (FAILED(result.getActivateResultCallHr)) {
        result.failureReason = std::string("GetActivateResult method call failed: ")
            + HresultHex(result.getActivateResultCallHr);
        return result;
    }

    if (FAILED(result.activationResultHr)) {
        result.failureReason = std::string("Async activation failed: ")
            + HresultHex(result.activationResultHr)
            + " (" + (HresultSymbol(result.activationResultHr) ? HresultSymbol(result.activationResultHr) : "") + ")";
        return result;
    }

    if (FAILED(result.queryAudioClientHr)) {
        result.failureReason = std::string("QueryInterface for IAudioClient failed: ")
            + HresultHex(result.queryAudioClientHr);
        return result;
    }

    // ── Get IAudioClient from handler ──
    ComPtr<IAudioClient> audioClient;
    {
        IAudioClient* rawClient = nullptr;
        HRESULT copyHr = handler->CopyAudioClient(&rawClient);
        if (FAILED(copyHr) || !rawClient) {
            result.queryAudioClientHr = copyHr;
            result.failureReason = "Failed to obtain IAudioClient from handler";
            return result;
        }
        audioClient.Attach(rawClient);
    }

    // ── Stage: CreateSampleEvent (auto-reset, not signaled initially) ──
    result.stage = AcActivationStage::CreateSampleEvent;
    HANDLE sampleEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!sampleEvent) {
        result.createEventHr = HRESULT_FROM_WIN32(GetLastError());
        result.failureReason = std::string("CreateEvent failed: ")
            + HresultHex(result.createEventHr);
        return result;
    }
    result.sampleReadyEvent = sampleEvent;
    result.createEventHr = S_OK;

    // ── Stage: InitializeAudioClient ──
    result.stage = AcActivationStage::InitializeAudioClient;
    {
        WAVEFORMATEXTENSIBLE format = MakeProcessLoopbackFormat();

        DWORD streamFlags =
            AUDCLNT_STREAMFLAGS_LOOPBACK |
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;

        result.initializeHr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            streamFlags,
            0,
            0,
            &format.Format,
            nullptr);

        if (FAILED(result.initializeHr)) {
            result.failureReason = std::string("IAudioClient::Initialize failed: ")
                + HresultHex(result.initializeHr)
                + " (" + (HresultSymbol(result.initializeHr) ? HresultSymbol(result.initializeHr) : "") + ")";
            return result;
        }
    }

    // ── Stage: GetBufferSize ──
    result.stage = AcActivationStage::GetBufferSize;
    {
        UINT32 frames = 0;
        result.getBufferSizeHr = audioClient->GetBufferSize(&frames);
        if (FAILED(result.getBufferSizeHr)) {
            result.failureReason = std::string("GetBufferSize failed: ")
                + HresultHex(result.getBufferSizeHr);
            return result;
        }
        result.bufferFrames = frames;
    }

    // ── Stage: GetCaptureClient ──
    result.stage = AcActivationStage::GetCaptureClient;
    {
        ComPtr<IAudioCaptureClient> captureClient;
        result.getCaptureClientHr = audioClient->GetService(
            __uuidof(IAudioCaptureClient),
            &captureClient);

        if (FAILED(result.getCaptureClientHr) || !captureClient) {
            result.failureReason = std::string("GetService(IAudioCaptureClient) failed: ")
                + HresultHex(result.getCaptureClientHr);
            return result;
        }

        captureClient.CopyTo(&result.captureClient);
    }

    // ── Stage: SetEventHandle ──
    result.stage = AcActivationStage::SetEventHandle;
    result.setEventHandleHr = audioClient->SetEventHandle(result.sampleReadyEvent);
    if (FAILED(result.setEventHandleHr)) {
        result.failureReason = std::string("SetEventHandle failed: ")
            + HresultHex(result.setEventHandleHr)
            + " (" + (HresultSymbol(result.setEventHandleHr) ? HresultSymbol(result.setEventHandleHr) : "") + ")";
        return result;
    }

    // ── Stage: StartAudioClient ──
    result.stage = AcActivationStage::StartAudioClient;
    result.startHr = audioClient->Start();
    if (FAILED(result.startHr)) {
        result.failureReason = std::string("IAudioClient::Start failed: ")
            + HresultHex(result.startHr)
            + " (" + (HresultSymbol(result.startHr) ? HresultSymbol(result.startHr) : "") + ")";
        return result;
    }

    // ── Success ──
    result.audioClient = audioClient.Detach();
    result.stage = AcActivationStage::Ready;
    result.succeeded = true;

    return result;
}

} // namespace screenlink::audio
