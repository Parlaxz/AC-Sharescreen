#include "AudioSessionMonitor.h"
#include "ProcessResolver.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <audioclient.h>

#include <coml2api.h>
#include <processthreadsapi.h>

#include <iostream>
#include <string>
#include <vector>

namespace screenlink::audio {

namespace {

// ── COM helpers ──

template <typename T>
void SafeRelease(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
}

std::string HresultToString(HRESULT hr) {
    char buf[32] = {};
    snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

// Convert wide string to UTF-8.
std::string WideToUtf8(PCWSTR wideStr, int length = -1) {
    if (wideStr == nullptr) return {};

    int realLength = (length >= 0) ? length : static_cast<int>(wcslen(wideStr));
    if (realLength == 0) return {};

    int needed = WideCharToMultiByte(CP_UTF8, 0, wideStr, realLength, nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return {};

    std::string result(static_cast<size_t>(needed), '\0');
    int written = WideCharToMultiByte(CP_UTF8, 0, wideStr, realLength, &result[0], needed, nullptr, nullptr);
    if (written <= 0) return {};

    return result;
}

// Get process image path from PID.
std::string GetProcessPathForPid(DWORD pid) {
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProcess) return {};

    WCHAR buffer[MAX_PATH + 1] = {};
    DWORD size = MAX_PATH;
    std::string result;
    if (QueryFullProcessImageNameW(hProcess, 0, buffer, &size)) {
        result = WideToUtf8(buffer, static_cast<int>(size));
    }
    CloseHandle(hProcess);
    return result;
}

// Get executable name for a PID (uses ProcessResolver or direct query).
std::string GetNameForPid(uint32_t pid) {
    std::string name = GetProcessName(pid);
    if (!name.empty()) return name;

    // Fallback: extract from path
    std::string path = GetProcessPathForPid(pid);
    auto pos = path.rfind('\\');
    if (pos == std::string::npos) return path;
    return path.substr(pos + 1);
}

// ── COM notification sink: IAudioSessionNotification ──

/// Lightweight COM sink that receives IAudioSessionManager2 session-created
/// notifications. Simply invokes the wake callback; does no heavy work.
class SessionNotificationSink final : public IAudioSessionNotification {
private:
    std::atomic<ULONG> refCount_{1};
    AudioSessionMonitor::AudioSessionChangedCallback callback_;

public:
    explicit SessionNotificationSink(AudioSessionMonitor::AudioSessionChangedCallback cb)
        : callback_(std::move(cb)) {}

    // ── IUnknown ──

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (!ppvObject) return E_POINTER;
        *ppvObject = nullptr;

        if (riid == __uuidof(IUnknown) || riid == __uuidof(IAudioSessionNotification)) {
            *ppvObject = static_cast<IAudioSessionNotification*>(this);
        } else {
            return E_NOINTERFACE;
        }

        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return refCount_.fetch_add(1) + 1;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG ref = refCount_.fetch_sub(1) - 1;
        if (ref == 0) {
            delete this;
        }
        return ref;
    }

    // ── IAudioSessionNotification ──

    HRESULT STDMETHODCALLTYPE OnSessionCreated(IAudioSessionControl* /*newSession*/) override {
        if (callback_) {
            callback_();
        }
        return S_OK;
    }
};

// ── COM notification sink: IMMNotificationClient ──

/// Lightweight COM sink that receives MMDevice endpoint-change notifications.
/// Only handles OnDefaultDeviceChanged for eRender+eConsole / eRender+eMultimedia,
/// setting the reinitialize-requested flag and invoking the wake callback.
class DeviceNotificationSink final : public IMMNotificationClient {
private:
    std::atomic<ULONG> refCount_{1};
    std::atomic<bool>& reinitializeRequested_;
    AudioSessionMonitor::AudioSessionChangedCallback callback_;

public:
    DeviceNotificationSink(std::atomic<bool>& reinitReq,
                           AudioSessionMonitor::AudioSessionChangedCallback cb)
        : reinitializeRequested_(reinitReq)
        , callback_(std::move(cb)) {}

    // ── IUnknown ──

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (!ppvObject) return E_POINTER;
        *ppvObject = nullptr;

        if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
            *ppvObject = static_cast<IMMNotificationClient*>(this);
        } else {
            return E_NOINTERFACE;
        }

        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return refCount_.fetch_add(1) + 1;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG ref = refCount_.fetch_sub(1) - 1;
        if (ref == 0) {
            delete this;
        }
        return ref;
    }

    // ── IMMNotificationClient ──

    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR /*deviceId*/, DWORD /*newState*/) override {
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR /*deviceId*/) override {
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR /*deviceId*/) override {
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role,
                                                      LPCWSTR /*newDeviceId*/) override {
        // Only react to render endpoint changes for console or multimedia roles
        if (flow == eRender && (role == eConsole || role == eMultimedia)) {
            reinitializeRequested_ = true;
            if (callback_) {
                callback_();
            }
        }
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR /*deviceId*/,
                                                      const PROPERTYKEY /*key*/) override {
        return S_OK;
    }
};

} // anonymous namespace

// ========================================================================
// AudioSessionMonitor
// ========================================================================

AudioSessionMonitor::AudioSessionMonitor() = default;

AudioSessionMonitor::~AudioSessionMonitor() {
    Stop();
}

bool AudioSessionMonitor::Initialize(AudioSessionChangedCallback onChanged) {
    // Store the callback
    onChangeCallback_ = std::move(onChanged);

    // 1. Initialize COM
    lastErrorCode_ = 0;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    comInitialized_ = (hr == S_OK || hr == S_FALSE);
    std::cerr << "[AudioSessionMonitor] CoInitializeEx result: " << HresultToString(hr) << std::endl;
    {
        APTTYPE aptType;
        APTTYPEQUALIFIER aptQualifier;
        HRESULT aptHr = CoGetApartmentType(&aptType, &aptQualifier);
        if (SUCCEEDED(aptHr)) {
            std::cerr << "[AudioSessionMonitor] Apartment type: " << static_cast<int>(aptType)
                      << ", qualifier: " << static_cast<int>(aptQualifier) << std::endl;
        } else {
            std::cerr << "[AudioSessionMonitor] CoGetApartmentType failed: " << HresultToString(aptHr) << std::endl;
        }
    }
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        lastErrorCode_ = static_cast<long>(hr);
        return false;
    }

    // 2. Create device enumerator using SDK __uuidof
    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr,
        CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
        reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) {
        std::cerr << "[AudioSessionMonitor] CoCreateInstance(MMDeviceEnumerator) failed: "
                  << HresultToString(hr) << std::endl;
        {
            std::cerr << "[AudioSessionMonitor] Process ID: " << GetCurrentProcessId() << std::endl;
            USHORT processMachine = IMAGE_FILE_MACHINE_UNKNOWN;
            USHORT nativeMachine = IMAGE_FILE_MACHINE_UNKNOWN;
            if (IsWow64Process2(GetCurrentProcess(), &processMachine, &nativeMachine)) {
                std::cerr << "[AudioSessionMonitor] Process arch: " << processMachine
                          << ", Native arch: " << nativeMachine << std::endl;
            }
            WCHAR exePath[MAX_PATH + 1] = {};
            DWORD pathLen = GetModuleFileNameW(nullptr, exePath, MAX_PATH);
            std::cerr << "[AudioSessionMonitor] Executable: " << WideToUtf8(exePath, static_cast<int>(pathLen)) << std::endl;
        }
        lastErrorCode_ = static_cast<long>(hr);
        Stop();
        return false;
    }
    deviceEnumerator_ = enumerator;

    // 3. Create device notification sink (before registering it)
    //    RefCount starts at 1; RegisterEndpointNotificationCallback will AddRef.
    DeviceNotificationSink* deviceSink = nullptr;
    if (onChangeCallback_) {
        deviceSink = new DeviceNotificationSink(reinitializeRequested_, onChangeCallback_);
        deviceNotificationSink_ = deviceSink;
    }

    // 4. Register device notification callback
    if (deviceSink) {
        hr = enumerator->RegisterEndpointNotificationCallback(
            static_cast<IMMNotificationClient*>(deviceSink));
        if (FAILED(hr)) {
            std::cerr << "[AudioSessionMonitor] RegisterEndpointNotificationCallback failed: "
                      << HresultToString(hr) << std::endl;
            lastErrorCode_ = static_cast<long>(hr);
            Stop();
            return false;
        }
    }

    // 5. Get default render endpoint
    IMMDevice* device = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr) || !device) {
        std::cerr << "[AudioSessionMonitor] GetDefaultAudioEndpoint failed: " << HresultToString(hr) << std::endl;
        lastErrorCode_ = static_cast<long>(hr);
        Stop();
        return false;
    }

    // 6. Activate session manager using SDK __uuidof
    IAudioSessionManager2* sessionManager = nullptr;
    hr = device->Activate(__uuidof(IAudioSessionManager2),
                          CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(&sessionManager));
    SafeRelease(device);
    if (FAILED(hr) || !sessionManager) {
        std::cerr << "[AudioSessionMonitor] Activate(IAudioSessionManager2) failed: "
                  << HresultToString(hr) << std::endl;
        lastErrorCode_ = static_cast<long>(hr);
        Stop();
        return false;
    }
    audioSessionManager_ = sessionManager;

    // 7. Create session notification sink (after session manager is available)
    SessionNotificationSink* sessionSink = nullptr;
    if (onChangeCallback_) {
        sessionSink = new SessionNotificationSink(onChangeCallback_);
        sessionNotificationSink_ = sessionSink;
    }

    // 8. Register session notification
    if (sessionSink) {
        hr = sessionManager->RegisterSessionNotification(
            static_cast<IAudioSessionNotification*>(sessionSink));
        if (FAILED(hr)) {
            std::cerr << "[AudioSessionMonitor] RegisterSessionNotification failed: "
                      << HresultToString(hr) << std::endl;
            lastErrorCode_ = static_cast<long>(hr);
            Stop();
            return false;
        }
    }

    return true;
}

std::vector<AudioSessionInfo> AudioSessionMonitor::EnumerateSessions() {
    std::vector<AudioSessionInfo> sessions;

    if (!audioSessionManager_) return sessions;

    // Get session enumerator
    IAudioSessionEnumerator* sessionEnum = nullptr;
    HRESULT hr = audioSessionManager_->GetSessionEnumerator(&sessionEnum);
    if (FAILED(hr) || !sessionEnum) {
        return sessions;
    }

    // Get session count
    int count = 0;
    hr = sessionEnum->GetCount(&count);
    if (FAILED(hr) || count <= 0) {
        SafeRelease(sessionEnum);
        return sessions;
    }

    // Enumerate each session
    for (int i = 0; i < count; ++i) {
        IAudioSessionControl* sessionCtrl = nullptr;
        hr = sessionEnum->GetSession(i, &sessionCtrl);
        if (FAILED(hr) || !sessionCtrl) {
            continue;
        }

        AudioSessionInfo info;

        // Get session state from IAudioSessionControl
        AudioSessionState state = AudioSessionStateInactive;
        hr = sessionCtrl->GetState(&state);
        if (SUCCEEDED(hr)) {
            info.sessionState = static_cast<uint32_t>(state);
        }

        // Get IAudioSessionControl2 for extended info
        IAudioSessionControl2* ctrl2 = nullptr;
        hr = sessionCtrl->QueryInterface(__uuidof(IAudioSessionControl2),
                                          reinterpret_cast<void**>(&ctrl2));
        if (FAILED(hr) || !ctrl2) {
            SafeRelease(sessionCtrl);
            continue;
        }

        // Get process ID
        DWORD pid = 0;
        hr = ctrl2->GetProcessId(&pid);
        if (FAILED(hr)) {
            info.errorReason = "GetProcessId failed: " + HresultToString(hr);
        }

        // Authoritative system-sounds check — do NOT rely on pid==0 heuristic alone.
        // AUDCLNT_E_DEVICE_INVALIDATED etc. are NOT automatically system sounds.
        HRESULT sysHr = ctrl2->IsSystemSoundsSession();
        if (sysHr == S_OK) {
            info.systemSound = true;
            info.pid = 0;
            info.executableName = "System Sounds";
        }

        // Populate PID (skip if already marked as system sound)
        if (!info.systemSound && SUCCEEDED(hr)) {
            info.pid = static_cast<uint32_t>(pid);
        }

        // Get session identifier
        LPWSTR str = nullptr;
        hr = ctrl2->GetSessionIdentifier(&str);
        if (SUCCEEDED(hr) && str) {
            info.sessionId = WideToUtf8(str);
            CoTaskMemFree(str);
            str = nullptr;
        }

        // Get session instance identifier
        hr = ctrl2->GetSessionInstanceIdentifier(&str);
        if (SUCCEEDED(hr) && str) {
            info.sessionInstanceId = WideToUtf8(str);
            CoTaskMemFree(str);
            str = nullptr;
        }

        // Get process path and name (only for non-system sessions with a valid PID)
        if (!info.systemSound && info.pid != 0) {
            info.executablePath = GetProcessPathForPid(static_cast<DWORD>(info.pid));
            info.executableName = GetNameForPid(info.pid);

            // Get creation time — a successful query proves the process
            // was alive and queryable during enumeration.
            const uint64_t creationTime = GetProcessCreationTime(info.pid);
            if (creationTime != 0) {
                info.creationTimeUtc100ns = creationTime;
                info.identityValidated = true;
                info.processAlive = true;
            } else {
                info.processAlive = false;
                info.identityValidated = false;
                if (info.errorReason.empty()) {
                    info.errorReason = "Process identity could not be validated";
                }
            }
        }

        SafeRelease(ctrl2);
        SafeRelease(sessionCtrl);
        sessions.push_back(std::move(info));
    }

    SafeRelease(sessionEnum);
    return sessions;
}

void AudioSessionMonitor::Stop() {
    // 1. Unregister session notification BEFORE releasing session manager
    if (audioSessionManager_ && sessionNotificationSink_) {
        audioSessionManager_->UnregisterSessionNotification(
            static_cast<IAudioSessionNotification*>(sessionNotificationSink_));
    }
    if (sessionNotificationSink_) {
        sessionNotificationSink_->Release();
        sessionNotificationSink_ = nullptr;
    }

    // 2. Release session manager
    if (audioSessionManager_) {
        audioSessionManager_->Release();
        audioSessionManager_ = nullptr;
    }

    // 3. Unregister device notification BEFORE releasing device enumerator
    if (deviceEnumerator_ && deviceNotificationSink_) {
        deviceEnumerator_->UnregisterEndpointNotificationCallback(
            static_cast<IMMNotificationClient*>(deviceNotificationSink_));
    }
    if (deviceNotificationSink_) {
        deviceNotificationSink_->Release();
        deviceNotificationSink_ = nullptr;
    }

    // 4. Release device enumerator
    if (deviceEnumerator_) {
        deviceEnumerator_->Release();
        deviceEnumerator_ = nullptr;
    }

    // 5. CoUninitialize
    if (comInitialized_) {
        CoUninitialize();
        comInitialized_ = false;
    }
}

} // namespace screenlink::audio
