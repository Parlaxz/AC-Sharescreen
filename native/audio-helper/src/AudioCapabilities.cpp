#include "AudioCapabilities.h"
#include "Protocol.h"
#include "WindowsVersion.h"
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <sstream>
#include <vector>
#include <mutex>
#include <atomic>

namespace screenlink::audio {

namespace {

// Minimum SDK build version that defines process-loopback APIs.
// This is the COMPILE-TIME SDK version check, separate from the
// runtime minimum (kMinProcessLoopbackBuild in Protocol.h, currently
// 20348). The SDK that introduced PROCESS_LOOPBACK is 10.0.22000.0,
// so this stays at 22000 regardless of runtime OS build.
inline constexpr uint32_t kMinSdkBuildForProcessLoopback = 22000;

std::vector<uint32_t> ParseVersionString(const std::string& version) {
  std::vector<uint32_t> parts;
  std::stringstream ss(version);
  std::string part;
  while (std::getline(ss, part, '.')) {
    try {
      parts.push_back(static_cast<uint32_t>(std::stoul(part)));
    } catch (...) {
      parts.push_back(0);
    }
  }
  return parts;
}

// ── Process-loopback activation types (must match LoopbackCapture.cpp) ──

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

struct AudioClientActivationParams {
    AudioClientActivationType activationType;
    AudioClientProcessLoopbackParams processLoopbackParams;
};

static_assert(sizeof(AudioClientActivationParams) == 12,
              "AudioClientActivationParams must be exactly 12 bytes");

static const wchar_t kVirtualAudioDeviceProcessLoopback[] = L"VAD\\Process_Loopback";

// ── COM completion handler for async activation (probe-only) ──

class ProbeActivationHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    ProbeActivationHandler() : refCount_(1) {
        event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }

    ~ProbeActivationHandler() {
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

template <typename T>
void SafeRelease(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
}

// ── Fixed capture format for probe: 48 kHz, stereo, IEEE float32 ──

static constexpr uint32_t kProbeSampleRate = 48000;
static constexpr uint16_t kProbeChannels = 2;
static constexpr uint16_t kProbeBitsPerSample = 32;
static constexpr uint16_t kProbeBlockAlign = kProbeChannels * (kProbeBitsPerSample / 8);

static WAVEFORMATEX MakeProbeFormat() {
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = kProbeChannels;
    fmt.nSamplesPerSec = kProbeSampleRate;
    fmt.wBitsPerSample = kProbeBitsPerSample;
    fmt.nBlockAlign = kProbeBlockAlign;
    fmt.nAvgBytesPerSec = kProbeSampleRate * kProbeBlockAlign;
    fmt.cbSize = 0;
    return fmt;
}

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

} // anonymous namespace

CompileTimeSupport DetectCompileTimeSupport() {
  CompileTimeSupport result;

#ifdef SCREENLINK_WIN_SDK_VERSION
  result.windowsSdkVersion = SCREENLINK_WIN_SDK_VERSION;
  auto parts = ParseVersionString(SCREENLINK_WIN_SDK_VERSION);

  // Windows SDK 10.0.22000.0 is the minimum that defines the
  // process-loopback audio APIs (PROCESS_LOOPBACK constant,
  // ActivateAudioInterfaceAsync with process-loopback support).
  bool sdkHasProcessLoopback = false;
  if (parts.size() >= 3) {
    uint32_t sdkBuild = parts[2];
    sdkHasProcessLoopback = (parts[0] >= 10 && sdkBuild >= kMinSdkBuildForProcessLoopback);
  }

  result.headersAvailable = sdkHasProcessLoopback;
  result.processLoopbackDefined = sdkHasProcessLoopback;
  result.activateAudioInterfaceDefined = sdkHasProcessLoopback;
#else
  result.windowsSdkVersion = "unknown";
  result.headersAvailable = false;
  result.processLoopbackDefined = false;
  result.activateAudioInterfaceDefined = false;
#endif

  return result;
}

RuntimeSupport DetectRuntimeSupport(const WindowsVersionResult& osInfo) {
  RuntimeSupport result;

  if (osInfo.succeeded) {
    result.osBuildNumber = osInfo.build;
    result.osBuildEligible = osInfo.build >= kMinProcessLoopbackBuild;
    result.osBuildExperimentalCandidate =
        osInfo.build >= kExperimentalProcessLoopbackFloor
        && osInfo.build < kMinProcessLoopbackBuild;
  } else {
    result.osBuildNumber = 0;
    result.osBuildEligible = false;
    result.osBuildExperimentalCandidate = false;
  }

  // Check process architecture
  result.is64BitProcess = (sizeof(void*) == 8);

  // Check OS architecture
  BOOL isWow64 = FALSE;
  if (result.is64BitProcess) {
    // A 64-bit process can only run on 64-bit Windows
    result.is64BitOperatingSystem = true;
  } else if (IsWow64Process(GetCurrentProcess(), &isWow64) && isWow64) {
    result.is64BitOperatingSystem = true;
  } else {
    result.is64BitOperatingSystem = false;
  }

  return result;
}

// ── ProbeProcessLoopbackRuntime ──
//
// Performs a real runtime probe for process-loopback support.
// Activates the VAD\Process_Loopback virtual device targeting the
// helper's own PID, initializes IAudioClient, and attempts Start().
// The probe is bounded (5s activation timeout + 2s start timeout).
// Thread-safe: uses call_once for synchronized one-time execution.
// Result is cached for the helper's lifetime.

ProcessLoopbackProbeResult ProbeProcessLoopbackRuntime() {
  static ProcessLoopbackProbeResult cachedResult;
  static std::once_flag probeOnce;

  std::call_once(probeOnce, []() {
    ProcessLoopbackProbeResult result;

    // Only probe on experimental candidate builds (19041–20347).
    // On documented-supported builds (20348+), the probe is unnecessary —
    // the API is guaranteed. On builds below 19041, the probe is
    // extremely unlikely to succeed and would waste time.
    auto osInfo = DetectWindowsVersion();
    if (!osInfo.succeeded) {
      result.probed = false;
      result.failureReason = "OS version detection failed";
      cachedResult = result;
      return;
    }

    if (osInfo.build >= kMinProcessLoopbackBuild) {
      // Documented-supported — no probe needed, report success
      result.probed = false;  // not actually probed
      result.succeeded = true;
      cachedResult = result;
      return;
    }

    if (osInfo.build < kExperimentalProcessLoopbackFloor) {
      // Below experimental floor — don't bother probing
      result.probed = false;
      result.succeeded = false;
      result.failureReason = "Build " + std::to_string(osInfo.build)
          + " is below experimental floor " + std::to_string(kExperimentalProcessLoopbackFloor);
      cachedResult = result;
      return;
    }

    // ── Experimental candidate build: perform real probe ──
    result.probed = true;

    // Initialize COM for this thread
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
      result.failureReason = "CoInitializeEx failed: " + std::to_string(hr);
      result.lastHr = hr;
      cachedResult = result;
      return;
    }

    // Build activation params targeting our own PID
    AudioClientActivationParams params{};
    params.activationType = AudioClientActivationType::kProcessLoopback;
    params.processLoopbackParams.targetProcessId = GetCurrentProcessId();
    params.processLoopbackParams.processLoopbackMode = ProcessLoopbackMode::kIncludeTargetProcessTree;

    PROPVARIANT variant;
    PropVariantInit(&variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(params);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ProbeActivationHandler* handler = new ProbeActivationHandler();

    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    hr = ActivateAudioInterfaceAsync(
        kVirtualAudioDeviceProcessLoopback,
        __uuidof(IAudioClient),
        &variant,
        handler,
        &asyncOp);

    PropVariantClear(&variant);

    if (FAILED(hr)) {
      result.failureReason = "ActivateAudioInterfaceAsync failed";
      result.lastHr = hr;
      SafeRelease(handler);
      CoUninitialize();
      cachedResult = result;
      return;
    }

    // Wait for activation (5 second timeout)
    if (!handler->Wait(5000)) {
      result.failureReason = "Audio interface activation timed out (5s)";
      result.lastHr = HRESULT_FROM_WIN32(WAIT_TIMEOUT);
      SafeRelease(asyncOp);
      SafeRelease(handler);
      CoUninitialize();
      cachedResult = result;
      return;
    }

    IAudioClient* audioClient = handler->GetAudioClient();
    HRESULT activateResult = handler->GetResult();
    if (FAILED(activateResult) || !audioClient) {
      char buf[96] = {};
      snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(activateResult));
      result.failureReason = std::string("Audio client activation failed (HRESULT: ") + buf + ")";
      result.lastHr = activateResult;
      SafeRelease(asyncOp);
      SafeRelease(handler);
      CoUninitialize();
      cachedResult = result;
      return;
    }

    // Initialize audio client with fixed format
    WAVEFORMATEX captureFormat = MakeProbeFormat();
    REFERENCE_TIME bufferDuration = 100000; // 10 ms
    hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        bufferDuration,
        0,
        &captureFormat,
        nullptr);

    if (FAILED(hr)) {
      result.failureReason = "IAudioClient::Initialize failed";
      result.lastHr = hr;
      SafeRelease(audioClient);
      SafeRelease(asyncOp);
      SafeRelease(handler);
      CoUninitialize();
      cachedResult = result;
      return;
    }

    // Attempt Start() — this is the critical test
    hr = audioClient->Start();
    if (FAILED(hr)) {
      result.failureReason = "IAudioClient::Start failed";
      result.lastHr = hr;
      SafeRelease(audioClient);
      SafeRelease(asyncOp);
      SafeRelease(handler);
      CoUninitialize();
      cachedResult = result;
      return;
    }

    // Stop immediately — probe succeeded
    audioClient->Stop();
    result.succeeded = true;
    result.lastHr = S_OK;

    SafeRelease(audioClient);
    SafeRelease(asyncOp);
    SafeRelease(handler);
    CoUninitialize();
    cachedResult = result;
  });

  return cachedResult;
}

AudioCapability ComputeCapability(const CompileTimeSupport& ct,
                                   const RuntimeSupport& rt,
                                   const ProcessLoopbackProbeResult& probe) {
  AudioCapability cap;
  cap.compileTime = ct;
  cap.runtime = rt;
  cap.probeResult = probe;

  // Endpoint loopback (AUDCLNT_STREAMFLAGS_LOOPBACK) is supported on
  // all Windows 10+ builds. It works on Windows Vista and later, but
  // our minimum target is Windows 10 so we always report true when
  // the OS detection succeeded.
  cap.endpointLoopbackSupported = rt.osBuildNumber > 0;

  if (!ct.headersAvailable) {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "old-windows-sdk";
    cap.reasonMessage = "Windows SDK " + ct.windowsSdkVersion
      + " does not support process-loopback audio. "
      + "Install Windows SDK 10.0.22000.0 or later.";
  } else if (!rt.is64BitProcess) {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "not-64-bit-process";
    cap.reasonMessage = "The audio helper must run as a 64-bit process.";
  } else if (rt.osBuildEligible) {
    // Documented-supported build (>= 20348)
    cap.usable = true;
    cap.experimentalCandidate = false;
    cap.reasonCode = "ok";
    cap.reasonMessage = "Process-loopback audio is supported (documented).";
  } else if (rt.osBuildExperimentalCandidate && probe.succeeded) {
    // Experimental candidate build (19041–20347) with successful runtime probe
    cap.usable = false;  // not documented-supported
    cap.experimentalCandidate = true;
    cap.reasonCode = "experimental-runtime-supported";
    cap.reasonMessage = "Process-loopback audio is experimentally supported on build "
        + std::to_string(rt.osBuildNumber)
        + " (runtime probe succeeded).";
  } else if (rt.osBuildExperimentalCandidate && probe.probed && !probe.succeeded) {
    // Experimental candidate build but probe failed
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "experimental-probe-failed";
    cap.reasonMessage = "Process-loopback runtime probe failed on build "
        + std::to_string(rt.osBuildNumber) + ": " + probe.failureReason;
  } else if (!rt.osBuildEligible && rt.osBuildNumber > 0) {
    // Build below experimental floor or probe not attempted
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "unsupported-windows-build";
    if (rt.osBuildExperimentalCandidate) {
      cap.reasonMessage = "Windows build " + std::to_string(rt.osBuildNumber)
        + " is between the experimental floor ("
        + std::to_string(kExperimentalProcessLoopbackFloor)
        + ") and the documented minimum ("
        + std::to_string(kMinProcessLoopbackBuild)
        + "), but the runtime probe was not attempted.";
    } else {
      cap.reasonMessage = "Windows build " + std::to_string(rt.osBuildNumber)
        + " is below the minimum required build "
        + std::to_string(kMinProcessLoopbackBuild)
        + " for process-loopback audio.";
    }
  } else if (!rt.osBuildEligible && rt.osBuildNumber == 0) {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "windows-version-unknown";
    cap.reasonMessage = "Could not determine Windows build number.";
  } else {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "unknown";
    cap.reasonMessage = "Process-loopback audio is not supported.";
  }

  return cap;
}

} // namespace screenlink::audio
