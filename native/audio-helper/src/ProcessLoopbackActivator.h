#ifndef SCREENLINK_PROCESS_LOOPBACK_ACTIVATOR_H
#define SCREENLINK_PROCESS_LOOPBACK_ACTIVATOR_H

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <string>

namespace screenlink::audio {

/// Activation type for IAudioClient activation params.
enum class AcActivationType : int32_t {
    kDefault = 0,
    kProcessLoopback = 1,
};

/// Process-loopback inclusion/exclusion mode.
enum class AcLoopbackMode : int32_t {
    kIncludeTargetProcessTree = 0,
    kExcludeTargetProcessTree = 1,
};

/// Per-process loopback params (matches SDK layout).
struct AcProcessLoopbackParams {
    DWORD targetProcessId;
    AcLoopbackMode processLoopbackMode;
};

/// Flat 12-byte layout for PROPVARIANT VT_BLOB.
/// ActivationType (int32) + targetProcessId (DWORD) + processLoopbackMode (int32).
struct AcActivationParams {
    AcActivationType activationType;
    AcProcessLoopbackParams processLoopbackParams;
};

static_assert(sizeof(AcActivationParams) == 12,
              "AcActivationParams must be exactly 12 bytes");

/// Virtual audio device path for process-loopback capture.
inline const wchar_t kVirtualAudioDeviceProcessLoopback[] = L"VAD\\Process_Loopback";

/// Full activation result including both IAudioClient and IAudioCaptureClient.
/// All COM pointers have their refcount incremented; caller must SafeRelease.
struct AcActivationResult {
    bool succeeded = false;
    std::string failureReason;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
};

/// Activate the process-loopback virtual device, initialize IAudioClient,
/// and obtain IAudioCaptureClient via GetService.
///
/// Blocks up to |timeoutMs| for the async activation to complete.
/// Handles internal cleanup of intermediate COM objects (handler, asyncOp).
///
/// @param targetPid  Target process PID for process-loopback capture
/// @param mode       Include (capture target only) or exclude (capture everything except target)
/// @param timeoutMs  Max wait time for async activation (default 5000)
///
/// The caller must:
///   - Have called CoInitializeEx on this thread before calling
///   - SafeRelease audioClient and captureClient when done
///   - Call CoUninitialize when done with COM on this thread
AcActivationResult ActivateProcessLoopback(
    DWORD targetPid,
    AcLoopbackMode mode,
    DWORD timeoutMs = 5000);

} // namespace screenlink::audio

#endif // SCREENLINK_PROCESS_LOOPBACK_ACTIVATOR_H
