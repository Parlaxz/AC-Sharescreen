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

    // 3. Get default render endpoint
    IMMDevice* device = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr) || !device) {
        std::cerr << "[AudioSessionMonitor] GetDefaultAudioEndpoint failed: " << HresultToString(hr) << std::endl;
        lastErrorCode_ = static_cast<long>(hr);
        Stop();
        return false;
    }

    // 4. Activate session manager using SDK __uuidof
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

        // Get IAudioSessionControl2 for extended info
        IAudioSessionControl2* ctrl2 = nullptr;
        hr = sessionCtrl->QueryInterface(__uuidof(IAudioSessionControl2),
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
        audioSessionManager_->Release();
        audioSessionManager_ = nullptr;
    }
    if (deviceEnumerator_) {
        deviceEnumerator_->Release();
        deviceEnumerator_ = nullptr;
    }
    if (comInitialized_) {
        CoUninitialize();
        comInitialized_ = false;
    }
}

} // namespace screenlink::audio
