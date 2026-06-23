#ifndef SCREENLINK_PROCESS_LOOPBACK_ACTIVATOR_H
#define SCREENLINK_PROCESS_LOOPBACK_ACTIVATOR_H

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <string>

namespace screenlink::audio {

/// Process-loopback inclusion/exclusion mode.
/// Maps directly to PROCESS_LOOPBACK_MODE from audioclientactivationparams.h.
enum class AcLoopbackMode : int32_t {
    kIncludeTargetProcessTree = 0,
    kExcludeTargetProcessTree = 1,
};

/// Stage of the activation pipeline. Each failure reports the exact stage.
enum class AcActivationStage {
    NotStarted,
    ResolveApi,
    ComInit,
    CreateHandler,
    BuildParameters,
    ActivateCall,
    WaitForCallback,
    GetActivateResult,
    QueryAudioClient,
    InitializeAudioClient,
    GetBufferSize,
    GetCaptureClient,
    CreateSampleEvent,
    SetEventHandle,
    StartAudioClient,
    Ready,
    StopAudioClient,
    Cleanup
};

/// Structured activation result with per-stage HRESULTs.
/// All fields are preserved independently; no collapsing into generic E_FAIL.
struct AcActivationResult {
    bool succeeded = false;
    AcActivationStage stage = AcActivationStage::NotStarted;
    std::string failureReason;

    // Per-stage HRESULTs -- each preserved at its exact origin.
    HRESULT comInitHr = E_UNEXPECTED;
    HRESULT activateCallHr = E_UNEXPECTED;
    HRESULT getActivateResultCallHr = E_UNEXPECTED;
    HRESULT activationResultHr = E_UNEXPECTED;
    HRESULT queryAudioClientHr = E_UNEXPECTED;
    HRESULT initializeHr = E_UNEXPECTED;
    HRESULT getBufferSizeHr = E_UNEXPECTED;
    HRESULT getCaptureClientHr = E_UNEXPECTED;
    HRESULT createEventHr = E_UNEXPECTED;
    HRESULT setEventHandleHr = E_UNEXPECTED;
    HRESULT startHr = E_UNEXPECTED;
    HRESULT stopHr = E_UNEXPECTED;

    // Owned COM pointers -- released on destruction
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;

    // Buffer info
    UINT32 bufferFrames = 0;
    HANDLE sampleReadyEvent = nullptr;

    ~AcActivationResult();
    AcActivationResult() = default;

    // Move-only
    AcActivationResult(AcActivationResult&& other) noexcept;
    AcActivationResult& operator=(AcActivationResult&& other) noexcept;

    // No copy
    AcActivationResult(const AcActivationResult&) = delete;
    AcActivationResult& operator=(const AcActivationResult&) = delete;

    /// Release owned resources without going through destructor.
    void Reset();
};

/// Convert stage to human-readable string.
const char* ActivationStageToString(AcActivationStage stage);

/// Return HRESULT as hex string (e.g. "0x8000000E").
std::string HresultHex(HRESULT hr);

/// Return symbolic name for common HRESULT values.
const char* HresultSymbol(HRESULT hr);

/// Activate the process-loopback virtual device, initialize IAudioClient,
/// obtain IAudioCaptureClient via GetService, set up event-driven capture.
///
/// Uses Microsoft::WRL::RuntimeClass with FtmBase for the completion handler.
/// Uses official AUDIOCLIENT_ACTIVATION_PARAMS from the Windows SDK.
/// Uses WAVEFORMATEXTENSIBLE with 48 kHz stereo float.
/// Uses AUDCLNT_STREAMFLAGS_LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM.
///
/// Blocks up to |timeoutMs| for the async activation to complete.
///
/// @param targetPid  Target process PID for process-loopback capture
/// @param mode       Include (capture target only) or exclude (capture everything except target)
/// @param timeoutMs  Max wait time for async activation (default 5000)
AcActivationResult ActivateProcessLoopback(
    DWORD targetPid,
    AcLoopbackMode mode,
    DWORD timeoutMs = 5000);

/// Dynamically resolve ActivateAudioInterfaceAsync from Mmdevapi.dll.
/// Returns nullptr if the function is not available.
typedef HRESULT(WINAPI* ActivateAudioInterfaceAsyncFn)(
    LPCWSTR,
    REFIID,
    PROPVARIANT*,
    IActivateAudioInterfaceCompletionHandler*,
    IActivateAudioInterfaceAsyncOperation**);

ActivateAudioInterfaceAsyncFn ResolveActivateAudioInterfaceAsync();

} // namespace screenlink::audio

#endif // SCREENLINK_PROCESS_LOOPBACK_ACTIVATOR_H
