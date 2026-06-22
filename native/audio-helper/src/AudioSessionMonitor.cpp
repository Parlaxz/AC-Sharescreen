#include "AudioSessionMonitor.h"
#include "ProcessResolver.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <audioclient.h>

#include <string>
#include <vector>

namespace screenlink::audio {

namespace {

// ── Local COM interface IIDs (avoid linker dependency on uuid.lib) ──

// {D666063F-1587-4E43-81F1-B948E807363F}
static const GUID IID_IMMDevice_ = {
    0xD666063F, 0x1587, 0x4E43, { 0x81, 0xF1, 0xB9, 0x48, 0xE8, 0x07, 0x36, 0x3F }
};

// {77AA99A0-1BD6-4840-94BC-2E6D6018714A}
static const GUID IID_IAudioSessionManager2_ = {
    0x77AA99A0, 0x1BD6, 0x4840, { 0x94, 0xBC, 0x2E, 0x6D, 0x60, 0x18, 0x71, 0x4A }
};

// {E2F5BB11-0570-40CA-ACDD-3AA01277DEE8}
static const GUID IID_IAudioSessionEnumerator_ = {
    0xE2F5BB11, 0x0570, 0x40CA, { 0xAC, 0xDD, 0x3A, 0xA0, 0x12, 0x77, 0xDE, 0xE8 }
};

// {F4B1A599-7266-4319-A8CA-E70ACB11E8CD}
static const GUID IID_IAudioSessionControl_ = {
    0xF4B1A599, 0x7266, 0x4319, { 0xA8, 0xCA, 0xE7, 0x0A, 0xCB, 0x11, 0xE8, 0xCD }
};

// {BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D}
static const GUID IID_IAudioSessionControl2_ = {
    0xBFB7FF88, 0x7239, 0x4FC9, { 0x8F, 0xA2, 0x07, 0xC9, 0x50, 0xBE, 0x9C, 0x6D }
};

// BCDE0395-E52F-467C-8E3D-C4579291692E
static const GUID CLSID_MMDeviceEnumerator_ = {
    0xBCDE0395, 0xE52F, 0x467C, { 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x92, 0x69, 0x2E }
};

// A95664D2-9614-4F35-A746-DE8DB63617E6
static const GUID IID_IMMDeviceEnumerator_ = {
    0xA95664D2, 0x9614, 0x4F35, { 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6 }
};

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

} // anonymous namespace

// ========================================================================
// AudioSessionMonitor
// ========================================================================

AudioSessionMonitor::AudioSessionMonitor() = default;

AudioSessionMonitor::~AudioSessionMonitor() {
    Stop();
}

bool AudioSessionMonitor::Initialize() {
    // 1. Initialize COM
    lastErrorCode_ = 0;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    comInitialized_ = (hr == S_OK || hr == S_FALSE);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        lastErrorCode_ = static_cast<long>(hr);
        return false;
    }

    // 2. Create device enumerator
    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(
        CLSID_MMDeviceEnumerator_, nullptr,
        CLSCTX_ALL, IID_IMMDeviceEnumerator_,
        reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) {
        lastErrorCode_ = static_cast<long>(hr);
        Stop();
        return false;
    }
    deviceEnumerator_ = enumerator;

    // 3. Get default render endpoint
    IMMDevice* device = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr) || !device) {
        lastErrorCode_ = static_cast<long>(hr);
        Stop();
        return false;
    }

    // 4. Activate session manager
    IAudioSessionManager2* sessionManager = nullptr;
    hr = device->Activate(IID_IAudioSessionManager2_,
                          CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(&sessionManager));
    SafeRelease(device);
    if (FAILED(hr) || !sessionManager) {
        lastErrorCode_ = static_cast<long>(hr);
        Stop();
        return false;
    }
    audioSessionManager_ = sessionManager;

    return true;
}

std::vector<AudioSessionInfo> AudioSessionMonitor::EnumerateSessions() {
    std::vector<AudioSessionInfo> sessions;

    if (!audioSessionManager_) return sessions;

    IAudioSessionManager2* mgr = static_cast<IAudioSessionManager2*>(audioSessionManager_);

    // Get session enumerator
    IAudioSessionEnumerator* sessionEnum = nullptr;
    HRESULT hr = mgr->GetSessionEnumerator(&sessionEnum);
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

        // Get IAudioSessionControl2 for extended info
        IAudioSessionControl2* ctrl2 = nullptr;
        hr = sessionCtrl->QueryInterface(IID_IAudioSessionControl2_,
                                          reinterpret_cast<void**>(&ctrl2));
        if (FAILED(hr) || !ctrl2) {
            SafeRelease(sessionCtrl);
            continue;
        }

        AudioSessionInfo info;

        // Get process ID
        DWORD pid = 0;
        hr = ctrl2->GetProcessId(&pid);
        if (FAILED(hr)) {
            info.errorReason = "GetProcessId failed: " + HresultToString(hr);
        }

        if (pid == 0 ||
            hr == AUDCLNT_E_DEVICE_INVALIDATED ||
            hr == AUDCLNT_E_NOT_INITIALIZED) {
            info.systemSound = true;
            info.pid = 0;
            info.executableName = "System Sounds";
            SafeRelease(ctrl2);
            SafeRelease(sessionCtrl);
            sessions.push_back(std::move(info));
            continue;
        }

        info.pid = static_cast<uint32_t>(pid);

        // Get session identifier (for display, but we just verify it's accessible)
        LPWSTR sessionIdStr = nullptr;
        hr = ctrl2->GetSessionIdentifier(&sessionIdStr);
        if (SUCCEEDED(hr) && sessionIdStr) {
            CoTaskMemFree(sessionIdStr);
        }

        // Get process path and name
        info.executablePath = GetProcessPathForPid(pid);
        info.executableName = GetNameForPid(pid);

        // Get creation time
        uint64_t ct = GetProcessCreationTime(pid);
        if (ct != 0) {
            info.creationTimeUtc100ns = ct;
            info.identityValidated = true;
        }

        if (info.executableName.empty() && info.executablePath.empty()) {
            info.systemSound = true;
        }

        SafeRelease(ctrl2);
        SafeRelease(sessionCtrl);
        sessions.push_back(std::move(info));
    }

    SafeRelease(sessionEnum);
    return sessions;
}

void AudioSessionMonitor::Stop() {
    if (audioSessionManager_) {
        SafeRelease(*reinterpret_cast<IAudioSessionManager2**>(&audioSessionManager_));
        audioSessionManager_ = nullptr;
    }
    if (deviceEnumerator_) {
        SafeRelease(*reinterpret_cast<IMMDeviceEnumerator**>(&deviceEnumerator_));
        deviceEnumerator_ = nullptr;
    }
    if (comInitialized_) {
        CoUninitialize();
        comInitialized_ = false;
    }
}

} // namespace screenlink::audio
