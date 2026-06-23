#include "ServiceSession.h"
#include "AudioCapabilities.h"
#include "WindowsVersion.h"
#include "Protocol.h"
#include "ExclusionPolicy.h"
#include "ProcessResolver.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace screenlink::audio {

// ========================================================================
// SimpleJson — minimal JSON builder/parser for the control protocol
// ========================================================================
namespace {

class SimpleJson {
public:
    SimpleJson& Set(const char* key, const char* value) {
        pairs_.emplace_back(std::string(key), "\"" + EscapeJson(value) + "\"");
        return *this;
    }

    SimpleJson& Set(const char* key, const std::string& value) {
        pairs_.emplace_back(std::string(key), "\"" + EscapeJson(value) + "\"");
        return *this;
    }

    /// Set a raw JSON value without quoting/escaping (e.g. pre-built JSON object).
    SimpleJson& SetRaw(const char* key, const std::string& rawJson) {
        pairs_.emplace_back(std::string(key), rawJson);
        return *this;
    }

    SimpleJson& Set(const char* key, int64_t value) {
        pairs_.emplace_back(std::string(key), std::to_string(value));
        return *this;
    }

    SimpleJson& Set(const char* key, uint64_t value) {
        pairs_.emplace_back(std::string(key), std::to_string(value));
        return *this;
    }

    SimpleJson& Set(const char* key, bool value) {
        pairs_.emplace_back(std::string(key), value ? "true" : "false");
        return *this;
    }

    SimpleJson& Set(const char* key, double value) {
        char buf[64];
        snprintf(buf, sizeof(buf), "%.17g", value);
        pairs_.emplace_back(std::string(key), buf);
        return *this;
    }

    /// Build the JSON object string.
    std::string Str() const {
        std::string out = "{";
        for (size_t i = 0; i < pairs_.size(); ++i) {
            if (i > 0) out += ",";
            out += "\"" + pairs_[i].first + "\":" + pairs_[i].second;
        }
        out += "}";
        return out;
    }

    // ── Parsing helpers (public) ──

    /// Extract the value of a string field from a JSON object.
    static std::string GetString(const std::string& json, const char* key) {
        std::string pattern = "\"" + std::string(key) + "\":\"";
        auto pos = json.find(pattern);
        if (pos == std::string::npos) return {};
        pos += pattern.size();
        std::string val;
        while (pos < json.size()) {
            char ch = json[pos];
            if (ch == '"') break;
            if (ch == '\\' && pos + 1 < json.size()) {
                ch = json[pos + 1];
                if (ch == '"') val += '"';
                else if (ch == '\\') val += '\\';
                else if (ch == 'n') val += '\n';
                else if (ch == 'r') val += '\r';
                else if (ch == 't') val += '\t';
                else if (ch == 'u' && pos + 5 < json.size()) {
                    val += json.substr(pos, 6);
                    pos += 6;
                    continue;
                } else val += ch;
                pos += 2;
                continue;
            }
            val += ch;
            ++pos;
        }
        return val;
    }

    /// Extract the value of an integer field.
    static int64_t GetInt(const std::string& json, const char* key,
                          int64_t defaultVal = 0) {
        auto val = GetRawNumber(json, key);
        if (val.empty()) return defaultVal;
        try { return static_cast<int64_t>(std::stoll(val)); }
        catch (...) { return defaultVal; }
    }

    /// Extract the value of an unsigned integer field.
    static uint64_t GetUint(const std::string& json, const char* key,
                            uint64_t defaultVal = 0) {
        auto val = GetRawNumber(json, key);
        if (val.empty()) return defaultVal;
        try { return static_cast<uint64_t>(std::stoull(val)); }
        catch (...) { return defaultVal; }
    }

    /// Extract the value of a boolean field.
    static bool GetBool(const std::string& json, const char* key,
                        bool defaultVal = false) {
        auto val = GetRawValue(json, key);
        if (val.empty()) return defaultVal;
        return val == "true";
    }

    /// Extract a sub-object (payload) value (returns raw JSON substring).
    static std::string GetObject(const std::string& json, const char* key) {
        std::string pattern = "\"" + std::string(key) + "\":{";
        auto pos = json.find(pattern);
        if (pos == std::string::npos) return {};
        pos += pattern.size();
        int braceDepth = 1;
        size_t start = pos;
        while (pos < json.size() && braceDepth > 0) {
            if (json[pos] == '{') ++braceDepth;
            else if (json[pos] == '}') --braceDepth;
            ++pos;
        }
        if (braceDepth != 0) return {};
        return "{" + json.substr(start, pos - start - 1) + "}";
    }

    /// Get the raw unquoted value for a key (for numbers, bools, null).
    static std::string GetRawValue(const std::string& json, const char* key) {
        std::string pattern = "\"" + std::string(key) + "\":";
        auto pos = json.find(pattern);
        if (pos == std::string::npos) return {};
        pos += pattern.size();
        while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
        if (pos >= json.size()) return {};
        if (json[pos] == '"') return {};
        size_t end = pos;
        while (end < json.size() && json[end] != ',' && json[end] != '}' &&
               json[end] != ' ' && json[end] != '\t' && json[end] != '\n' &&
               json[end] != '\r') {
            ++end;
        }
        return json.substr(pos, end - pos);
    }

private:
    /// JSON-escape a string value.
    static std::string EscapeJson(const std::string& s) {
        std::string out;
        out.reserve(s.size() + 8);
        for (auto ch : s) {
            switch (ch) {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n";  break;
                case '\r': out += "\\r";  break;
                case '\t': out += "\\t";  break;
                case '\b': out += "\\b";  break;
                case '\f': out += "\\f";  break;
                default:
                    if (static_cast<unsigned char>(ch) < 0x20) {
                        char buf[8] = {};
                        snprintf(buf, sizeof(buf), "\\u%04x",
                                 static_cast<unsigned char>(ch));
                        out += buf;
                    } else {
                        out += ch;
                    }
                    break;
            }
        }
        return out;
    }

    /// Get a numeric value (no quotes) — delegates to GetRawValue.
    static std::string GetRawNumber(const std::string& json, const char* key) {
        return GetRawValue(json, key);
    }

    std::vector<std::pair<std::string, std::string>> pairs_;
};

// ── Helper: Create SECURITY_ATTRIBUTES restricted to current user only ──

bool CreateCurrentUserSecurityAttributes(SECURITY_ATTRIBUTES& sa,
                                          std::vector<char>& secDescBuf,
                                          std::vector<char>& aclBuf) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        return false;
    }

    DWORD tokenInfoLen = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &tokenInfoLen);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        CloseHandle(token);
        return false;
    }
    std::vector<char> tokenInfoBuf(tokenInfoLen);
    TOKEN_USER* tokenUser = reinterpret_cast<TOKEN_USER*>(tokenInfoBuf.data());
    if (!GetTokenInformation(token, TokenUser, tokenUser, tokenInfoLen, &tokenInfoLen)) {
        CloseHandle(token);
        return false;
    }
    CloseHandle(token);

    aclBuf.resize(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) +
                  GetLengthSid(tokenUser->User.Sid) - sizeof(DWORD));
    PACL acl = reinterpret_cast<PACL>(aclBuf.data());
    if (!InitializeAcl(acl, static_cast<DWORD>(aclBuf.size()), ACL_REVISION)) {
        return false;
    }
    if (!AddAccessAllowedAce(acl, ACL_REVISION, GENERIC_ALL, tokenUser->User.Sid)) {
        return false;
    }

    secDescBuf.resize(SECURITY_DESCRIPTOR_MIN_LENGTH);
    PSECURITY_DESCRIPTOR sd = reinterpret_cast<PSECURITY_DESCRIPTOR>(secDescBuf.data());
    if (!InitializeSecurityDescriptor(sd, SECURITY_DESCRIPTOR_REVISION)) {
        return false;
    }
    if (!SetSecurityDescriptorDacl(sd, TRUE, acl, FALSE)) {
        return false;
    }

    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;

    return true;
}

// ── Helpers for state-to-string conversion ──

const char* StateToStr(int state) {
    switch (state) {
        case 0: return "idle";
        case 1: return "starting";
        case 2: return "capturing";
        case 3: return "stopping";
        case 4: return "error";
        default: return "unknown";
    }
}

// ── Phase 2F: Rate-limited stderr logger ──

/// Simple rate-limited logger: at most one message per N milliseconds.
class RateLimitedLogger {
public:
    explicit RateLimitedLogger(uint64_t intervalMs) : intervalMs_(intervalMs) {}

    void Log(const std::string& msg) {
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            now - lastLog_).count();
        if (elapsed >= static_cast<int64_t>(intervalMs_)) {
            std::cerr << msg << std::endl;
            lastLog_ = now;
        }
    }

private:
    uint64_t intervalMs_;
    std::chrono::steady_clock::time_point lastLog_;
};

/// Global rate-limited logger instance (5-second interval).
RateLimitedLogger g_errorLog(5000);

/// Get QPC timestamp in 100ns units.
uint64_t GetQpcTimestamp100ns() {
    LARGE_INTEGER qpc;
    QueryPerformanceCounter(&qpc);
    LARGE_INTEGER freq;
    QueryPerformanceFrequency(&freq);
    return static_cast<uint64_t>(
        (static_cast<double>(qpc.QuadPart) * 10000000.0) /
        static_cast<double>(freq.QuadPart));
}

// ── Phase 2F: Wide-to-UTF8 helper for path logging ──

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

} // anonymous namespace

// ========================================================================
// ServiceSession
// ========================================================================

ServiceSession::ServiceSession(ServiceConfig config)
    : config_(std::move(config))
{
}

ServiceSession::~ServiceSession() {
    running_.store(false);

    // Cancel any pending control pipe I/O
    if (controlPipe_ != nullptr) {
        HANDLE hPipe = static_cast<HANDLE>(controlPipe_);
        CancelIoEx(hPipe, nullptr);
        CloseHandle(hPipe);
        controlPipe_ = nullptr;
    }

    // Stop PCM writer
    pcmWriter_.Stop();

    // Signal capture thread to stop
    if (state_.load() == static_cast<SessionState>(2)) { // kCapturing
        state_.store(static_cast<SessionState>(3)); // kStopping
    }

    // Stop Phase 2E multi-source resources before joining threads
    StopPhase2EResources();

    // Join threads
    if (captureThread_.joinable()) captureThread_.join();
    if (controlThread_.joinable()) controlThread_.join();
    if (pcmConnectThread_.joinable()) pcmConnectThread_.join();
    if (monitorThread_.joinable()) monitorThread_.join();

    // Stop and clean up multi-source capture sources
    for (auto& source : captureSources_) {
        if (source) source->Stop();
    }
    captureSources_.clear();

    // Stop mixer
    if (mixer_) {
        mixer_->Stop();
        mixer_.reset();
    }

    // Stop session monitor
    if (sessionMonitor_) {
        sessionMonitor_->Stop();
        sessionMonitor_.reset();
    }

    // Close parent process handle
    if (parentProcessHandle_ != nullptr) {
        CloseHandle(static_cast<HANDLE>(parentProcessHandle_));
        parentProcessHandle_ = nullptr;
    }
}

int ServiceSession::Run() {
    startTime_ = std::chrono::steady_clock::now();
    helperStartCount_++;

    // Log helper identity on startup
    {
        WCHAR exePath[MAX_PATH + 1] = {};
        DWORD pathLen = GetModuleFileNameW(nullptr, exePath, MAX_PATH);
        std::string exeStr = WideToUtf8(exePath, static_cast<int>(pathLen));
        std::cerr << "[helper] Started: " << exeStr
                  << " (PID: " << GetCurrentProcessId() << ")" << std::endl;
    }

    // Start PCM writer (creates pipe and waits for connection in its own thread)
    if (!pcmWriter_.Start(config_.pcmPipeName, config_.parentPid)) {
        std::cerr << "Failed to start PCM pipe writer\n";
        return static_cast<int>(ExitCode::kServeFailed);
    }

    // Start control thread
    controlThread_ = std::thread(&ServiceSession::ControlThread, this);

    // Start parent monitor thread
    monitorThread_ = std::thread(&ServiceSession::ParentMonitorThread, this);

    // Wait for running_ to become false (shutdown requested)
    while (running_.load()) {
        Sleep(100);
    }

    // Cleanup
    pcmWriter_.Stop();

    if (controlPipe_ != nullptr) {
        HANDLE hPipe = static_cast<HANDLE>(controlPipe_);
        CancelIoEx(hPipe, nullptr);
        CloseHandle(hPipe);
        controlPipe_ = nullptr;
    }

    // Stop any active capture
    if (captureThread_.joinable()) {
        state_.store(static_cast<SessionState>(3)); // kStopping
        captureThread_.join();
        state_.store(static_cast<SessionState>(0)); // kIdle
    }

    return static_cast<int>(ExitCode::kSuccess);
}

// ========================================================================
// ControlThread
// ========================================================================

void ServiceSession::ControlThread() {
    // Create the control named pipe (message mode)

    // Security: restrict pipe access to current user only
    SECURITY_ATTRIBUTES sa = {};
    std::vector<char> secDescBuf;
    std::vector<char> aclBuf;
    LPSECURITY_ATTRIBUTES lpSa = nullptr;
    if (CreateCurrentUserSecurityAttributes(sa, secDescBuf, aclBuf)) {
        lpSa = &sa;
    }

    HANDLE hPipe = CreateNamedPipeA(
        config_.controlPipeName.c_str(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
        PIPE_REJECT_REMOTE_CLIENTS,
        1,        // max instances
        65536,    // out buffer
        65536,    // in buffer
        0,        // default timeout
        lpSa);    // security attributes

    if (hPipe == INVALID_HANDLE_VALUE) {
        g_errorLog.Log("[helper] Failed to create control pipe: " + std::to_string(GetLastError()));
        running_.store(false);
        return;
    }

    controlPipe_ = static_cast<void*>(hPipe);
    std::cerr << "[helper] CTL: waiting for client..." << std::endl;

    while (running_.load()) {
        // Wait for client to connect
        BOOL connected = ConnectNamedPipe(hPipe, nullptr);
        if (!connected) {
            DWORD err = GetLastError();
            if (err == ERROR_PIPE_CONNECTED) {
                std::cerr << "[helper] CTL: client already connected" << std::endl;
            } else if (err == ERROR_NO_DATA) {
                std::cerr << "[helper] CTL: client disconnected" << std::endl;
                DisconnectNamedPipe(hPipe);
                continue;
            } else {
                std::cerr << "[helper] CTL: ConnectNamedPipe error " << err << std::endl;
                if (running_.load()) { Sleep(10); }
                continue;
            }
        } else {
            std::cerr << "[helper] CTL: client connected" << std::endl;
        }

        // Verify client PID matches expected parent
        {
            ULONG clientPid = 0;
            if (GetNamedPipeClientProcessId(hPipe, &clientPid) && clientPid != 0 &&
                config_.parentPid != 0 && clientPid != config_.parentPid) {
                std::cerr << "[helper] CTL: PID rejection " << clientPid << " != " << config_.parentPid << std::endl;
                DisconnectNamedPipe(hPipe);
                continue;
            }
            std::cerr << "[helper] CTL: client PID " << clientPid << " accepted" << std::endl;
        }

        // Process requests from this client until disconnect or shutdown
        // Byte mode with newline-delimited JSON framing.
        std::string lineBuffer;
        char chunk[65536];

        while (running_.load()) {
            DWORD bytesRead = 0;
            BOOL readOk = ReadFile(hPipe, chunk, sizeof(chunk) - 1,
                                   &bytesRead, nullptr);
            if (!readOk) {
                DWORD err = GetLastError();
                if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED) {
                    // Client disconnected — wait for next connection
                }
                break; // Exit inner loop to reconnect
            }

            if (bytesRead == 0) break;

            chunk[bytesRead] = '\0';
            lineBuffer.append(chunk, bytesRead);

            // Process complete lines
            size_t pos;
            while ((pos = lineBuffer.find('\n')) != std::string::npos) {
                std::string requestLine = lineBuffer.substr(0, pos);
                lineBuffer.erase(0, pos + 1);

                // Skip empty lines
                if (requestLine.empty()) continue;

                totalControlRequests_.fetch_add(1, std::memory_order_relaxed);

                // Parse the request
                std::string sessionId = SimpleJson::GetString(requestLine, "sessionId");
                std::string authToken = SimpleJson::GetString(requestLine, "authToken");
                std::string command = SimpleJson::GetString(requestLine, "command");
                std::string payload = SimpleJson::GetObject(requestLine, "payload");
                uint64_t requestId = SimpleJson::GetUint(requestLine, "requestId", 0);

                // Validate auth
                if (!ValidateRequest(authToken, sessionId)) {
                    failedControlRequests_.fetch_add(1, std::memory_order_relaxed);
                    lastErrorTimestamp_ = GetQpcTimestamp100ns();
                    g_errorLog.Log("[helper] Auth failure for request from pipe client");

                    SimpleJson resp;
                    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
                    resp.Set("requestId", requestId);
                    resp.Set("sessionId", config_.sessionId);
                    resp.Set("success", false);
                    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
                    resp.Set("error", "authentication-failed");
                    resp.SetRaw("result", "{}");
                    std::string respStr = resp.Str();

                    respStr += '\n';
                    DWORD bytesWritten = 0;
                    WriteFile(hPipe, respStr.data(),
                              static_cast<DWORD>(respStr.size()),
                              &bytesWritten, nullptr);
                    continue;
                }

                // Dispatch command
                std::string response;
                bool recognised = DispatchCommand(command, payload, response);

                if (!recognised) {
                    failedControlRequests_.fetch_add(1, std::memory_order_relaxed);
                    SimpleJson resp;
                    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
                    resp.Set("requestId", requestId);
                    resp.Set("sessionId", config_.sessionId);
                    resp.Set("success", false);
                    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
                    resp.Set("error", "unknown-command");
                    resp.SetRaw("result", "{}");
                    std::string respStr = resp.Str();
                    respStr += '\n';

                    DWORD bytesWritten = 0;
                    WriteFile(hPipe, respStr.data(),
                              static_cast<DWORD>(respStr.size()),
                              &bytesWritten, nullptr);
                    continue;
                }

                // Send response (add newline delimiter for byte-mode protocol)
                response += '\n';
                DWORD bytesWritten = 0;
                WriteFile(hPipe, response.data(),
                          static_cast<DWORD>(response.size()),
                          &bytesWritten, nullptr);

                // Check if this was a shutdown command
                if (command == "shutdown") {
                    Sleep(50);
                    running_.store(false);
                    break;
                }
            }

            // Guard against unbounded line buffer growth
            if (lineBuffer.size() > 65536) {
                lineBuffer.clear();
            }
        }

        // Disconnect for next client
        DisconnectNamedPipe(hPipe);
    }

    // Close the pipe
    CloseHandle(hPipe);
    controlPipe_ = nullptr;
}

// ========================================================================
// DispatchCommand
// ========================================================================

bool ServiceSession::DispatchCommand(const std::string& command,
                                      const std::string& payload,
                                      std::string& response) {
    if (command == "hello") {
        HandleHello(payload, response);
        return true;
    } else if (command == "getVersion" || command == "getversion") {
        HandleGetVersion(payload, response);
        return true;
    } else if (command == "getCapabilities" || command == "getcapabilities") {
        HandleGetCapabilities(payload, response);
        return true;
    } else if (command == "getState" || command == "getstate") {
        HandleGetState(payload, response);
        return true;
    } else if (command == "startSynthetic" || command == "startsynthetic") {
        HandleStartSynthetic(payload, response);
        return true;
    } else if (command == "startProcessCapture" ||
               command == "startprocesscapture") {
        HandleStartProcessCapture(payload, response);
        return true;
    } else if (command == "stopCapture" || command == "stopcapture") {
        HandleStopCapture(payload, response);
        return true;
    } else if (command == "getDiagnostics" || command == "getdiagnostics") {
        HandleGetDiagnostics(payload, response);
        return true;
    } else if (command == "ping") {
        HandlePing(payload, response);
        return true;
    } else if (command == "shutdown") {
        HandleShutdown(payload, response);
        return true;
    } else if (command == "enumerateAudioSessions" ||
               command == "enumerateaudiosessions") {
        HandleEnumerateAudioSessions(payload, response);
        return true;
    } else if (command == "startApplicationAudio" ||
               command == "startapplicationaudio") {
        HandleStartApplicationAudio(payload, response);
        return true;
    } else if (command == "startFilteredMonitorAudio" ||
               command == "startfilteredmonitoraudio") {
        HandleStartFilteredMonitorAudio(payload, response);
        return true;
    } else if (command == "getMixerState" ||
               command == "getmixerstate") {
        HandleGetMixerState(payload, response);
        return true;
    } else if (command == "getMixerDiagnostics" ||
               command == "getmixerdiagnostics") {
        HandleGetMixerDiagnostics(payload, response);
        return true;
    } else if (command == "startEndpointLoopback" ||
               command == "startendpointloopback") {
        HandleStartEndpointLoopback(payload, response);
        return true;
    }
    return false;
}

// ========================================================================
// ValidateRequest
// ========================================================================

bool ServiceSession::ValidateRequest(const std::string& authToken,
                                      const std::string& sessionId) {
    if (authToken != config_.authToken) return false;
    if (sessionId != config_.sessionId) return false;
    return true;
}

// ========================================================================
// MakeErrorResponse
// ========================================================================

std::string ServiceSession::MakeErrorResponse(const std::string& errorCode) {
    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", false);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.Set("error", errorCode);
    resp.SetRaw("result", "{}");
    return resp.Str();
}

// ========================================================================
// Command Handlers
// ========================================================================

void ServiceSession::HandleHello(const std::string& /*payload*/,
                                  std::string& response) {
    std::string result = "{";
    result += "\"helperVersion\":\"" + std::string(kHelperVersion) + "\",";
    result += "\"protocolVersion\":\"" + std::string(kServiceProtocolVersion) + "\",";
    result += "\"sessionId\":\"" + config_.sessionId + "\",";
    result += "\"pid\":" + std::to_string(static_cast<uint64_t>(GetCurrentProcessId()));
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetVersion(const std::string& /*payload*/,
                                       std::string& response) {
    std::string result = "{";
    result += "\"helperVersion\":\"" + std::string(kHelperVersion) + "\",";
    result += "\"protocolVersion\":\"" + std::string(kServiceProtocolVersion) + "\"";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetCapabilities(const std::string& /*payload*/,
                                            std::string& response) {
    auto osInfo = DetectWindowsVersion();
    auto compileTime = DetectCompileTimeSupport();
    auto runtime = DetectRuntimeSupport(osInfo);
    auto probe = ProbeProcessLoopbackRuntime();
    auto cap = ComputeCapability(compileTime, runtime, probe);

    bool runtimeSupported = cap.usable || cap.experimentalCandidate;

    // Build result as a JSON string
    std::string result = "{";
    result += "\"osVersion\":{";
    result += "\"major\":" + std::to_string(osInfo.major) + ",";
    result += "\"minor\":" + std::to_string(osInfo.minor) + ",";
    result += "\"build\":" + std::to_string(osInfo.build) + ",";
    result += "\"revision\":" + std::to_string(osInfo.revision);
    result += "},";
    result += "\"compiledWindowsSdkVersion\":\"";
    result += compileTime.windowsSdkVersion + "\",";
    result += "\"processLoopbackRuntimeSupported\":";
    result += (runtimeSupported ? "true" : "false") + std::string(",");
    result += "\"processLoopbackDocumentedSupported\":";
    result += (cap.usable ? "true" : "false") + std::string(",");
    result += "\"processLoopbackExperimentalCandidate\":";
    result += (cap.experimentalCandidate ? "true" : "false") + std::string(",");
    result += "\"processLoopbackProbed\":";
    result += (probe.probed ? "true" : "false") + std::string(",");
    result += "\"processLoopbackProbeSucceeded\":";
    result += (probe.succeeded ? "true" : "false") + std::string(",");
    result += "\"processLoopbackProbeFailureReason\":\"";
    result += probe.failureReason + "\",";
    result += "\"endpointLoopbackSupported\":";
    result += (cap.endpointLoopbackSupported ? "true" : "false") + std::string(",");
    result += "\"usable\":";
    result += (cap.usable ? "true" : "false") + std::string(",");
    result += "\"experimentalCandidate\":";
    result += (cap.experimentalCandidate ? "true" : "false") + std::string(",");
    result += "\"reasonCode\":\"";
    result += cap.reasonCode + "\",";
    result += "\"reasonMessage\":\"";
    result += cap.reasonMessage + "\"";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetState(const std::string& /*payload*/,
                                     std::string& response) {
    auto uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - startTime_).count();

    int currentState = static_cast<int>(state_.load());

    std::string activeSrc;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSrc = activeSourceType_;
    }

    std::string result = "{";
    result += "\"state\":\"";
    result += StateToStr(currentState) + std::string("\",");
    result += "\"activeSourceType\":\"";
    result += activeSrc + "\",";
    result += "\"uptimeMs\":" + std::to_string(static_cast<uint64_t>(uptime)) + ",";
    result += "\"controlConnected\":true,";
    result += "\"pcmConnected\":true,";
    result += "\"streamGeneration\":" +
              std::to_string(streamGeneration_.load()) + ",";
    result += "\"totalPackets\":" +
              std::to_string(totalPackets_.load());
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(currentState));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartSynthetic(const std::string& payload,
                                           std::string& response) {
    // Parse payload
    int64_t mode = SimpleJson::GetInt(payload, "mode", 0);
    int64_t totalPackets = SimpleJson::GetInt(payload, "totalPackets", 0);
    int64_t framesPerPacket = SimpleJson::GetInt(payload, "framesPerPacket", 480);

    // Check we're not already capturing (state must be kIdle = 0)
    int expected = 0; // kIdle
    if (state_.load() != static_cast<SessionState>(expected)) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "already-capturing");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // Validate mode
    if (mode < 0 || mode > 5) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", "invalid-mode");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    state_.store(static_cast<SessionState>(1)); // kStarting
    uint32_t gen = streamGeneration_.fetch_add(1) + 1;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_ = "synthetic";
    }

    // Configure synthesis
    SyntheticConfig cfg;
    cfg.mode = static_cast<SyntheticMode>(mode);
    cfg.sampleRate = 48000;
    cfg.channels = 2;
    cfg.framesPerPacket = static_cast<uint32_t>(
        (std::min)(static_cast<int64_t>(960),
                   (std::max)(static_cast<int64_t>(1), framesPerPacket)));
    cfg.totalPackets = static_cast<uint32_t>(
        (std::min)(static_cast<int64_t>(1000000),
                   (std::max)(static_cast<int64_t>(0), totalPackets)));
    cfg.streamGeneration = static_cast<uint32_t>(gen);

    state_.store(static_cast<SessionState>(2)); // kCapturing

    // Wait for PCM pipe client to be connected before starting capture
    {
        int waitCount = 0;
        while (!pcmWriter_.IsClientConnected() && waitCount < 100) {
            Sleep(10);
            waitCount++;
        }
        if (!pcmWriter_.IsClientConnected()) {
            // PCM pipe not connected — abort
            state_.store(static_cast<SessionState>(0)); // kIdle
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                activeSourceType_ = "";
            }
            streamGeneration_.fetch_sub(1);
            SimpleJson resp;
            resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
            resp.Set("requestId", static_cast<uint64_t>(0));
            resp.Set("sessionId", config_.sessionId);
            resp.Set("success", false);
            resp.Set("state", "idle");
            resp.Set("error", "pcm-not-connected");
            resp.SetRaw("result", "{}");
            response = resp.Str();
            return;
        }
    }

    // Launch synthetic capture thread
    captureThread_ = std::thread(&ServiceSession::RunSyntheticCapture,
                                  this, cfg);

    std::string result = "{";
    result += "\"streamGeneration\":" + std::to_string(gen) + ",";
    result += "\"sourceType\":\"synthetic\"";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartProcessCapture(const std::string& payload,
                                                 std::string& response) {
    // Parse payload
    int64_t targetPid = SimpleJson::GetInt(payload, "targetPid", 0);
    uint64_t expectedCreationTime =
        SimpleJson::GetUint(payload, "expectedCreationTimeUtc100ns", 0);
    std::string mode = SimpleJson::GetString(payload, "mode");
    bool includeMode = (mode != "exclude");

    if (targetPid <= 0) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "invalid-target-pid");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // Check process-loopback support
    if (!IsProcessLoopbackSupported()) {
        auto osInfo = DetectWindowsVersion();
        auto probeResult = ProbeProcessLoopbackRuntime();
        std::string result;
        if (osInfo.build >= kExperimentalProcessLoopbackFloor && osInfo.build < kMinProcessLoopbackBuild) {
            result = "{";
            result += "\"error\":\"process-loopback-experimental-probe-failed\",";
            result += "\"requiresBuild\":" + std::to_string(kMinProcessLoopbackBuild) + ",";
            result += "\"currentBuild\":" + std::to_string(osInfo.build) + ",";
            result += "\"experimentalFloor\":" + std::to_string(kExperimentalProcessLoopbackFloor) + ",";
            result += "\"probeFailure\":\"" + probeResult.failureReason + "\"";
            result += "}";
        } else {
            result = "{";
            result += "\"error\":\"process-loopback-unsupported\",";
            result += "\"requiresBuild\":" + std::to_string(kMinProcessLoopbackBuild) + ",";
            result += "\"currentBuild\":" + std::to_string(osInfo.build);
            result += "}";
        }

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "process-loopback-unsupported");
        resp.SetRaw("result", result);
        response = resp.Str();
        return;
    }

    // Check we're not already capturing
    if (state_.load() != static_cast<SessionState>(0)) { // kIdle
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "already-capturing");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    state_.store(static_cast<SessionState>(1)); // kStarting
    uint32_t gen = streamGeneration_.fetch_add(1) + 1;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_ = "process";
    }

    CaptureConfig captureCfg;
    captureCfg.targetPid = static_cast<uint32_t>(targetPid);
    captureCfg.expectedCreationTimeUtc100ns = expectedCreationTime;
    captureCfg.includeMode = includeMode;
    captureCfg.durationMs = 0; // 0 = infinite (until stopped)

    state_.store(static_cast<SessionState>(2)); // kCapturing

    // Launch process capture thread
    captureThread_ = std::thread(&ServiceSession::RunProcessCapture,
                                  this, captureCfg);

    std::string result = "{";
    result += "\"streamGeneration\":" + std::to_string(gen) + ",";
    result += "\"sourceType\":\"process\"";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStopCapture(const std::string& /*payload*/,
                                        std::string& response) {
    int previousState = static_cast<int>(state_.load());

    if (previousState != 2 && previousState != 1) { // kCapturing, kStarting
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(previousState));
        resp.Set("error", "not-capturing");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    state_.store(static_cast<SessionState>(3)); // kStopping

    // Join capture thread
    if (captureThread_.joinable()) {
        captureThread_.join();
    }

    // Stop Phase 2E multi-source resources
    StopPhase2EResources();

    uint64_t finalPacketCount = totalPackets_.load();
    state_.store(static_cast<SessionState>(0)); // kIdle

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_ = "";
    }

    std::string result = "{";
    result += "\"previousState\":\"";
    result += StateToStr(previousState) + std::string("\",");
    result += "\"finalPacketCount\":" +
              std::to_string(finalPacketCount);
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "idle");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetDiagnostics(const std::string& /*payload*/,
                                           std::string& response) {
    auto uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - startTime_).count();

    uint64_t packets = totalPackets_.load();
    uint64_t payloadBytes = totalPayloadBytes_.load();
    uint64_t ctrlReqs = totalControlRequests_.load();
    uint64_t failedReqs = failedControlRequests_.load();
    uint32_t dropped = pcmWriter_.Queue().DroppedCount();
    size_t queueSize = pcmWriter_.Queue().Size();
    size_t written = pcmWriter_.PacketsWritten();
    size_t writeErrors = pcmWriter_.WriteErrors();
    uint32_t streamGen = streamGeneration_.load();
    int currentState = static_cast<int>(state_.load());

    std::string activeSrc;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSrc = activeSourceType_;
    }

    std::string result = "{";
    result += "\"totalPackets\":" + std::to_string(packets) + ",";
    result += "\"totalPayloadBytes\":" + std::to_string(payloadBytes) + ",";
    result += "\"droppedPackets\":" + std::to_string(dropped) + ",";
    result += "\"queueSize\":" + std::to_string(queueSize) + ",";
    result += "\"packetsWritten\":" + std::to_string(written) + ",";
    result += "\"writeErrors\":" + std::to_string(writeErrors) + ",";
    result += "\"totalControlRequests\":" + std::to_string(ctrlReqs) + ",";
    result += "\"failedControlRequests\":" + std::to_string(failedReqs) + ",";
    result += "\"uptimeMs\":" + std::to_string(static_cast<uint64_t>(uptime)) + ",";
    result += "\"activeSourceType\":\"";
    result += activeSrc + "\",";
    result += "\"state\":\"";
    result += StateToStr(currentState) + std::string("\",");
    result += "\"streamGeneration\":" + std::to_string(streamGen) + ",";
    result += "\"helperStartCount\":" + std::to_string(helperStartCount_) + ",";
    result += "\"lastErrorTimestamp\":" + std::to_string(lastErrorTimestamp_) + ",";
    result += "\"capturePacketsProduced\":" + std::to_string(capturePacketsProduced_.load()) + ",";
    result += "\"captureBytesProduced\":" + std::to_string(captureBytesProduced_.load()) + ",";
    result += "\"endpointPacketsCaptured\":" + std::to_string(endpointPacketsCaptured_.load()) + ",";
    result += "\"endpointNonZeroPackets\":" + std::to_string(endpointNonZeroPackets_.load()) + ",";
    result += "\"endpointSilentPackets\":" + std::to_string(endpointSilentPackets_.load()) + ",";
    result += "\"mixerFeedPackets\":" + std::to_string(mixerFeedPackets_.load()) + ",";
    result += "\"mixerOutputPackets\":" + std::to_string(mixerOutputPackets_.load()) + ",";
    result += "\"mixerNonZeroOutputPackets\":" + std::to_string(mixerNonZeroOutputPackets_.load()) + ",";
    result += "\"onCaptureAccepted\":" + std::to_string(onCaptureAccepted_.load()) + ",";
    result += "\"onCaptureRejectedState\":" + std::to_string(onCaptureRejectedState_.load());
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(currentState));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandlePing(const std::string& /*payload*/,
                                 std::string& response) {
    auto uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - startTime_).count();

    std::string result = "{";
    result += "\"uptimeMs\":" + std::to_string(static_cast<uint64_t>(uptime));
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleShutdown(const std::string& /*payload*/,
                                     std::string& response) {
    // If capturing, stop first
    if (state_.load() == static_cast<SessionState>(2)) { // kCapturing
        state_.store(static_cast<SessionState>(3)); // kStopping
        if (captureThread_.joinable()) {
            captureThread_.join();
        }
        state_.store(static_cast<SessionState>(0)); // kIdle
    }

    // Stop Phase 2E multi-source resources
    StopPhase2EResources();

    std::string result = "{";
    result += "\"exitCode\":0";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "idle");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

// ========================================================================
// Phase 2E — Multi-source audio mixer handlers
// ========================================================================

void ServiceSession::HandleEnumerateAudioSessions(const std::string& /*payload*/,
                                                    std::string& response) {
    // Create session monitor
    auto monitor = std::make_unique<AudioSessionMonitor>();
    if (!monitor->Initialize()) {
        long hresult = monitor->LastErrorCode();
        char errorBuf[96] = {};
        snprintf(errorBuf, sizeof(errorBuf),
                 "session-enumeration-failed (HRESULT=0x%08lx)", hresult);
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", errorBuf);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    auto sessions = monitor->EnumerateSessions();
    monitor->Stop();

    // Build result JSON: {"sessionCount":N,"sessions":[{...},{...}]}
    std::string result = "{";
    result += "\"sessionCount\":" + std::to_string(sessions.size()) + ",";
    result += "\"sessions\":[";
    for (size_t i = 0; i < sessions.size(); ++i) {
        if (i > 0) result += ",";
        result += "{";
        result += "\"pid\":" + std::to_string(sessions[i].pid) + ",";
        // Use a simple escaping: replace " with \" in the name
        std::string safeName = sessions[i].executableName;
        {
            size_t pos = 0;
            while ((pos = safeName.find('"', pos)) != std::string::npos) {
                safeName.replace(pos, 1, "\\\"");
                pos += 2;
            }
        }
        result += "\"executableName\":\"" + safeName + "\",";
        result += "\"systemSound\":";
        result += (sessions[i].systemSound ? "true" : "false");
        result += ",";
        result += "\"identityValidated\":";
        result += (sessions[i].identityValidated ? "true" : "false");
        if (!sessions[i].errorReason.empty()) {
            std::string safeError = sessions[i].errorReason;
            size_t pos = 0;
            while ((pos = safeError.find('"', pos)) != std::string::npos) {
                safeError.replace(pos, 1, "\\\"");
                pos += 2;
            }
            result += ",\"errorReason\":\"" + safeError + "\"";
        }
        result += "}";
    }
    result += "]}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartApplicationAudio(const std::string& payload,
                                                   std::string& response) {
    // Parse payload
    int64_t targetPid = SimpleJson::GetInt(payload, "targetPid", 0);
    uint64_t expectedCreationTime = SimpleJson::GetUint(payload, "expectedCreationTimeUtc100ns", 0);

    if (targetPid <= 0) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "invalid-target-pid");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    state_.store(SessionState::kStarting);

    // Validate process exists and creation time matches
    uint64_t actualCreationTime = GetProcessCreationTime(static_cast<uint32_t>(targetPid));
    if (actualCreationTime == 0) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "process-not-found");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        state_.store(SessionState::kIdle);
        return;
    }

    if (expectedCreationTime != 0 && actualCreationTime != expectedCreationTime) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "creation-time-mismatch");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        state_.store(SessionState::kIdle);
        return;
    }

    // Resolve application root
    auto treeResult = ResolveProcessTree(static_cast<uint32_t>(targetPid));
    if (!treeResult.succeeded) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "process-resolution-failed");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        state_.store(SessionState::kIdle);
        return;
    }

    uint32_t rootPid = treeResult.applicationRootPid;

    // Check process-loopback support (Application Audio requires it)
    if (!IsProcessLoopbackSupported()) {
        auto osInfo = DetectWindowsVersion();
        auto probeResult = ProbeProcessLoopbackRuntime();
        std::string result;
        if (osInfo.build >= kExperimentalProcessLoopbackFloor && osInfo.build < kMinProcessLoopbackBuild) {
            result = "{";
            result += "\"error\":\"process-loopback-experimental-probe-failed\",";
            result += "\"requiresBuild\":" + std::to_string(kMinProcessLoopbackBuild) + ",";
            result += "\"currentBuild\":" + std::to_string(osInfo.build) + ",";
            result += "\"experimentalFloor\":" + std::to_string(kExperimentalProcessLoopbackFloor) + ",";
            result += "\"probeFailure\":\"" + probeResult.failureReason + "\"";
            result += "}";
        } else {
            result = "{";
            result += "\"requiresBuild\":" + std::to_string(kMinProcessLoopbackBuild) + ",";
            result += "\"currentBuild\":" + std::to_string(osInfo.build);
            result += "}";
        }

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "process-loopback-unsupported");
        resp.SetRaw("result", result);
        response = resp.Str();
        state_.store(SessionState::kIdle);
        return;
    }

    // Try to start the capture source FIRST, before creating mixer
    auto source = std::make_unique<ApplicationCaptureSource>();
    AppCaptureStartOutcome startOutcome = source->Start(rootPid, actualCreationTime,
        [](const AudioPacket&) -> bool {
            return true; // temporary — will be re-attached after mixer creation
        });

    if (startOutcome.result != AppCaptureStartResult::Success) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "capture-start-failed");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        state_.store(SessionState::kIdle);
        return;
    }

    // Source started — now create mixer and register
    if (!mixer_) {
        mixer_ = std::make_unique<MultiSourceMixer>(48000, static_cast<uint16_t>(2));
    }

    // Stop the temporary capture, add to mixer, restart with real callback
    uint32_t sourceId = mixer_->AddSource(rootPid, actualCreationTime);
    source->Stop();

    AppCaptureStartOutcome restartOutcome = source->Start(rootPid, actualCreationTime,
        [this, sourceId](const AudioPacket& p) -> bool {
            mixer_->FeedPacket(sourceId, p);
            return true;
        });

    if (restartOutcome.result != AppCaptureStartResult::Success) {
        mixer_->RemoveSource(sourceId);
        state_.store(SessionState::kIdle);
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "capture-start-failed");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // Now start the mixer
    auto mixResult = mixer_->Start([this](const AudioPacket& p) -> bool {
        return OnCapturePacket(p);
    });

    if (!mixResult.success) {
        source->Stop();
        mixer_->RemoveSource(sourceId);
        state_.store(SessionState::kIdle);

        const char* errorCode = "mixer-start-failed";
        switch (mixResult.error) {
            case MultiSourceMixer::StartError::AlreadyRunning:
                errorCode = "mixer-already-running";
                break;
            case MultiSourceMixer::StartError::NoOutputCallback:
                errorCode = "mixer-no-output-callback";
                break;
            case MultiSourceMixer::StartError::ThreadCreationFailed:
                errorCode = "mixer-thread-creation-failed";
                break;
            case MultiSourceMixer::StartError::StaleThreadNotJoined:
                errorCode = "mixer-stale-thread";
                break;
            default: break;
        }
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", errorCode);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    captureSources_.push_back(std::move(source));
    state_.store(SessionState::kCapturing);

    std::string result = "{";
    result += "\"sourceId\":" + std::to_string(sourceId) + ",";
    result += "\"rootPid\":" + std::to_string(rootPid) + ",";
    // Escape rootName for JSON safety
    {
        std::string safeName = treeResult.applicationRootName;
        size_t pos = 0;
        while ((pos = safeName.find('"', pos)) != std::string::npos) {
            safeName.replace(pos, 1, "\\\"");
            pos += 2;
        }
        result += "\"rootName\":\"" + safeName + "\"";
    }
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartFilteredMonitorAudio(const std::string& payload,
                                                       std::string& response) {
    bool excludeDiscord = SimpleJson::GetBool(payload, "excludeDiscord", true);
    bool excludeScreenLink = SimpleJson::GetBool(payload, "excludeScreenLink", true);
    uint32_t screenLinkPid = static_cast<uint32_t>(
        SimpleJson::GetUint(payload, "screenLinkPid", 0));

    // ── 1. Validate OS capability ──
    auto osInfo = DetectWindowsVersion();
    uint32_t currentBuild = osInfo.build;
    if (!IsProcessLoopbackSupported()) {
        auto probeResult = ProbeProcessLoopbackRuntime();
        std::string result;
        if (currentBuild >= kExperimentalProcessLoopbackFloor && currentBuild < kMinProcessLoopbackBuild) {
            result = "{";
            result += "\"error\":\"process-loopback-experimental-probe-failed\",";
            result += "\"requiresBuild\":" + std::to_string(kMinProcessLoopbackBuild) + ",";
            result += "\"currentBuild\":" + std::to_string(currentBuild) + ",";
            result += "\"experimentalFloor\":" + std::to_string(kExperimentalProcessLoopbackFloor) + ",";
            result += "\"probeFailure\":\"" + probeResult.failureReason + "\"";
            result += "}";
        } else {
            result = "{";
            result += "\"error\":\"process-loopback-unsupported\",";
            result += "\"requiresBuild\":" + std::to_string(kMinProcessLoopbackBuild) + ",";
            result += "\"currentBuild\":" + std::to_string(currentBuild);
            result += "}";
        }

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "process-loopback-unsupported");
        resp.SetRaw("result", result);
        response = resp.Str();
        return;
    }

    // ── 2. Enumerate sessions ──
    auto monitor = std::make_unique<AudioSessionMonitor>();
    if (!monitor->Initialize()) {
        long hresult = monitor->LastErrorCode();
        char errorBuf[96] = {};
        snprintf(errorBuf, sizeof(errorBuf),
                 "session-enumeration-failed (HRESULT=0x%08lx)", hresult);
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", errorBuf);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    auto sessions = monitor->EnumerateSessions();
    monitor->Stop();
    std::cerr << "[filtered] sessions.enumerated=" << sessions.size() << std::endl;

    // ── 3. Process sessions: exclusions, dedup, source starts ──
    uint32_t eligibleCount = 0;
    uint32_t excludedDiscordCount = 0;
    uint32_t excludedScreenLinkCount = 0;
    uint32_t duplicateRootCount = 0;
    uint32_t invalidSessionCount = 0;
    uint32_t sourcesAttempted = 0;
    uint32_t sourcesStarted = 0;
    uint32_t sourcesFailed = 0;
    std::vector<std::string> sourceFailureCodes;

    struct RootIdentity {
        uint32_t pid;
        uint64_t creationTimeUtc100ns;
    };
    std::vector<RootIdentity> addedRoots;

    // First pass: determine which process trees should be captured
    struct SelectedSource {
        uint32_t rootPid;
        uint64_t rootCreationTime;
    };
    std::vector<SelectedSource> selectedSources;

    for (const auto& session : sessions) {
        if (session.systemSound || session.pid == 0) {
            invalidSessionCount++;
            continue;
        }
        if (!session.identityValidated) {
            invalidSessionCount++;
            continue;
        }

        auto treeResult = ResolveProcessTree(session.pid);
        if (!treeResult.succeeded) {
            invalidSessionCount++;
            continue;
        }

        uint32_t rootPid = treeResult.applicationRootPid;
        uint64_t rootCreationTime = treeResult.targetCreationTimeUtc100ns;

        std::string rootName = treeResult.applicationRootName;
        std::string rootPath;
        for (const auto& p : treeResult.processes) {
            if (p.processId == rootPid) {
                rootPath = p.processPath;
                break;
            }
        }

        // Apply exclusion policy
        if (excludeDiscord || excludeScreenLink) {
            auto exclusion = CheckExclusion(rootName, rootPath);
            if (exclusion.isDiscord && excludeDiscord) {
                excludedDiscordCount++;
                continue;
            }
            if (exclusion.isScreenLink && excludeScreenLink) {
                bool shouldExclude = true;
                if (screenLinkPid != 0 && rootPid != screenLinkPid) {
                    shouldExclude = false;
                }
                if (shouldExclude) {
                    excludedScreenLinkCount++;
                    continue;
                }
            }
        }

        // Deduplicate by root PID + creation time
        bool isDuplicate = false;
        for (const auto& added : addedRoots) {
            if (added.pid == rootPid && added.creationTimeUtc100ns == rootCreationTime) {
                isDuplicate = true;
                break;
            }
        }
        if (isDuplicate) {
            duplicateRootCount++;
            continue;
        }
        addedRoots.push_back({rootPid, rootCreationTime});

        eligibleCount++;
        selectedSources.push_back({rootPid, rootCreationTime});
    }

    std::cerr << "[filtered] sessions.excluded=" << excludedDiscordCount + excludedScreenLinkCount
              << " processTrees.selected=" << selectedSources.size() << std::endl;

    if (selectedSources.empty()) {
        // All sessions were excluded or invalid — no-capturable-sessions, not a mixer failure
        std::string result = "{";
        result += "\"totalSessions\":" + std::to_string(sessions.size()) + ",";
        result += "\"eligibleCount\":" + std::to_string(eligibleCount) + ",";
        result += "\"excludedDiscordCount\":" + std::to_string(excludedDiscordCount) + ",";
        result += "\"excludedScreenLinkCount\":" + std::to_string(excludedScreenLinkCount) + ",";
        result += "\"duplicateRootCount\":" + std::to_string(duplicateRootCount) + ",";
        result += "\"invalidSessionCount\":" + std::to_string(invalidSessionCount);
        result += "}";

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "no-capturable-sessions");
        resp.SetRaw("result", result);
        response = resp.Str();
        return;
    }

    // ── 4. Try to start capture sources for each selected process ──
    // Only the sources that actually start are registered with the mixer.
    struct StartedSource {
        uint32_t rootPid;
        uint64_t rootCreationTime;
        uint32_t sourceId;    // mixer source ID (assigned after mixer creation)
        std::unique_ptr<ApplicationCaptureSource> captureSource;
    };
    std::vector<StartedSource> startedSources;

    for (const auto& sel : selectedSources) {
        sourcesAttempted++;
        std::cerr << "[filtered] source.start.attempt: pid=" << sel.rootPid << std::endl;

        auto source = std::make_unique<ApplicationCaptureSource>();

        // The source won't be registered with the mixer yet — we'll do that after
        // confirming it started. We need a temporary callback that feeds packets
        // but we don't have a sourceId yet. So we create a placeholder callback.
        // Instead, we start the capture with a no-op temporary callback, then
        // re-attach if successful.
        //
        // Better approach: start capture first, then add to mixer.
        AppCaptureStartOutcome startOutcome = source->Start(sel.rootPid, sel.rootCreationTime,
            [](const AudioPacket&) -> bool {
                // Temporary — the real callback will be set when the source
                // is registered with the mixer after mixer creation.
                return true;
            });

        if (startOutcome.result == AppCaptureStartResult::Success) {
            std::cerr << "[filtered] source.start.result: started pid=" << sel.rootPid << std::endl;
            sourcesStarted++;
            startedSources.push_back({
                sel.rootPid, sel.rootCreationTime, 0, std::move(source)
            });
        } else {
            sourcesFailed++;
            sourceFailureCodes.push_back("capture-start-failed");
            std::cerr << "[filtered] source.start.result: failed pid=" << sel.rootPid << std::endl;
        }
    }

    std::cerr << "[filtered] sources.attempted=" << sourcesAttempted
              << " sources.started=" << sourcesStarted
              << " sources.failed=" << sourcesFailed << std::endl;

    if (sourcesStarted == 0) {
        // No sources could be started — all capture sources failed
        std::string result = "{";
        result += "\"totalSessions\":" + std::to_string(sessions.size()) + ",";
        result += "\"eligibleCount\":" + std::to_string(eligibleCount) + ",";
        result += "\"sourcesAttempted\":" + std::to_string(sourcesAttempted) + ",";
        result += "\"sourcesFailed\":" + std::to_string(sourcesFailed) + ",";
        result += "\"sourceFailureCodes\":[";
        for (size_t i = 0; i < sourceFailureCodes.size(); ++i) {
            if (i > 0) result += ",";
            result += "\"" + sourceFailureCodes[i] + "\"";
        }
        result += "],";
        result += "\"requiresBuild\":" + std::to_string(kMinProcessLoopbackBuild) + ",";
        result += "\"currentBuild\":" + std::to_string(currentBuild);
        result += "}";

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "capture-start-failed");
        resp.SetRaw("result", result);
        response = resp.Str();
        return;
    }

    // ── 5. Create mixer and register successful sources ──
    if (!mixer_) {
        mixer_ = std::make_unique<MultiSourceMixer>(48000, static_cast<uint16_t>(2));
    }

    // Register each source with the mixer and re-attach the callback
    for (auto& ss : startedSources) {
        uint32_t sourceId = mixer_->AddSource(ss.rootPid, ss.rootCreationTime);
        ss.sourceId = sourceId;

        // Replace the temporary callback with the real one that feeds the mixer
        ss.captureSource->Stop();  // Stop the temporary capture
        AppCaptureStartOutcome restartOutcome = ss.captureSource->Start(ss.rootPid, ss.rootCreationTime,
            [this, sourceId](const AudioPacket& p) -> bool {
                mixer_->FeedPacket(sourceId, p);
                return true;
            });

        if (restartOutcome.result == AppCaptureStartResult::Success) {
            std::cerr << "[filtered] source registered: sourceId=" << sourceId
                      << " pid=" << ss.rootPid << std::endl;
        } else {
            // Failed on restart — shouldn't happen if first start succeeded
            mixer_->RemoveSource(sourceId);
            sourcesStarted--;
            std::cerr << "[filtered] source restart failed: pid=" << ss.rootPid << std::endl;
        }
    }

    if (sourcesStarted == 0) {
        // All sources failed on the re-attach — unusual but handle it
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "capture-start-failed");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // ── 6. Start mixer (now with sources registered) ──
    std::cerr << "[filtered] mixer.start.enter: sources=" << mixer_->SourceCount() << std::endl;
    auto mixResult = mixer_->Start([this](const AudioPacket& p) -> bool {
        return OnCapturePacket(p);
    });
    std::cerr << "[filtered] mixer.start.result: success=" << mixResult.success
              << " error=" << static_cast<int>(mixResult.error) << std::endl;

    if (!mixResult.success) {
        // Clean up sources
        for (auto& ss : startedSources) {
            ss.captureSource->Stop();
        }
        startedSources.clear();
        if (mixer_) {
            mixer_->Stop();
            mixer_.reset();
        }

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));

        // Map mixer error to a diagnostics string
        const char* errorCode = "mixer-start-failed";
        switch (mixResult.error) {
            case MultiSourceMixer::StartError::AlreadyRunning:
                errorCode = "mixer-already-running";
                break;
            case MultiSourceMixer::StartError::NoOutputCallback:
                errorCode = "mixer-no-output-callback";
                break;
            case MultiSourceMixer::StartError::InvalidFormat:
                errorCode = "mixer-invalid-format";
                break;
            case MultiSourceMixer::StartError::ThreadCreationFailed:
                errorCode = "mixer-thread-creation-failed";
                break;
            case MultiSourceMixer::StartError::StaleThreadNotJoined:
                errorCode = "mixer-stale-thread";
                break;
            default:
                break;
        }
        resp.Set("error", errorCode);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        std::cerr << "[filtered] mixer.start.result=" << errorCode << std::endl;
        return;
    }

    // ── 7. Transfer ownership of started sources ──
    for (auto& ss : startedSources) {
        captureSources_.push_back(std::move(ss.captureSource));
    }

    uint32_t activeSourceCount = mixer_->SourceCount();
    std::cerr << "[filtered] start.result: success activeSources=" << activeSourceCount << std::endl;

    std::string result = "{";
    result += "\"totalSessions\":" + std::to_string(sessions.size()) + ",";
    result += "\"eligibleCount\":" + std::to_string(eligibleCount) + ",";
    result += "\"excludedDiscordCount\":" + std::to_string(excludedDiscordCount) + ",";
    result += "\"excludedScreenLinkCount\":" + std::to_string(excludedScreenLinkCount) + ",";
    result += "\"duplicateRootCount\":" + std::to_string(duplicateRootCount) + ",";
    result += "\"invalidSessionCount\":" + std::to_string(invalidSessionCount) + ",";
    result += "\"sourcesAttempted\":" + std::to_string(sourcesAttempted) + ",";
    result += "\"sourcesStarted\":" + std::to_string(sourcesStarted) + ",";
    result += "\"activeSourceCount\":" + std::to_string(activeSourceCount);
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartEndpointLoopback(const std::string& /*payload*/,
                                                  std::string& response) {
    // Parse payload (if any) — currently no options needed.
    // Future: could add eMultimedia/eCommunications/eConsole routing.

    // 1. Reject if not idle
    if (state_.load() != static_cast<SessionState>(0)) { // kIdle
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "already-capturing");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // 2. Set state=kStarting, increment generation, set activeSourceType_
    state_.store(static_cast<SessionState>(1)); // kStarting
    uint32_t gen = streamGeneration_.fetch_add(1) + 1;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_ = "endpoint-loopback";
    }

    // 3. Wait for PCM client connection (up to 100 x 10ms)
    {
        int waitCount = 0;
        while (!pcmWriter_.IsClientConnected() && waitCount < 100) {
            Sleep(10);
            waitCount++;
        }
        if (!pcmWriter_.IsClientConnected()) {
            // PCM pipe not connected — rollback
            state_.store(static_cast<SessionState>(0)); // kIdle
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                activeSourceType_ = "";
            }
            streamGeneration_.fetch_sub(1);
            SimpleJson resp;
            resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
            resp.Set("requestId", static_cast<uint64_t>(0));
            resp.Set("sessionId", config_.sessionId);
            resp.Set("success", false);
            resp.Set("state", "idle");
            resp.Set("error", "pcm-not-connected");
            resp.SetRaw("result", "{}");
            response = resp.Str();
            return;
        }
    }

    // 4. Create mixer if needed; add sourceId
    if (!mixer_) {
        mixer_ = std::make_unique<MultiSourceMixer>(48000, static_cast<uint16_t>(2));
    }
    uint32_t sourceId = mixer_->AddSource(0, 0);

    // 5. Create endpointSource_, call Start(...) and capture EndpointStartOutcome
    endpointSource_ = std::make_unique<EndpointLoopbackSource>();
    auto startOutcome = endpointSource_->Start(
        [this, sourceId](const AudioPacket& p) -> bool {
            // Endpoint callback
            endpointPacketsCaptured_.fetch_add(1, std::memory_order_relaxed);

            if (p.isSilent) {
                endpointSilentPackets_.fetch_add(1, std::memory_order_relaxed);
            } else {
                // Detect a nonzero sample from first up to 10 samples
                bool hasNonZero = false;
                uint32_t checkSamples = (std::min)(static_cast<uint32_t>(10),
                    p.frameCount * static_cast<uint32_t>(p.channels));
                for (uint32_t i = 0; i < checkSamples; ++i) {
                    if (p.frames != nullptr && p.frames[i] != 0.0f) {
                        hasNonZero = true;
                        break;
                    }
                }
                if (hasNonZero) {
                    endpointNonZeroPackets_.fetch_add(1, std::memory_order_relaxed);
                }
            }

            mixerFeedPackets_.fetch_add(1, std::memory_order_relaxed);
            mixer_->FeedPacket(sourceId, p);
            return true;
        });

    // 6. Check endpoint Start() result
    if (startOutcome.result != EndpointStartResult::Success) {
        // Rollback
        endpointSource_.reset();
        mixer_->RemoveSource(sourceId);
        state_.store(static_cast<SessionState>(0)); // kIdle
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            activeSourceType_ = "";
        }
        streamGeneration_.fetch_sub(1);

        // Map EndpointStartResult to structured error strings
        const char* errorCode = "capture-start-failed";
        switch (startOutcome.result) {
            case EndpointStartResult::ComInitFailed:
                errorCode = "com-init-failed";
                break;
            case EndpointStartResult::EnumeratorFailed:
                errorCode = "enumerator-failed";
                break;
            case EndpointStartResult::EndpointNotFound:
                errorCode = "endpoint-not-found";
                break;
            case EndpointStartResult::AudioClientActivationFailed:
                errorCode = "audio-client-activation-failed";
                break;
            case EndpointStartResult::GetMixFormatFailed:
                errorCode = "get-mix-format-failed";
                break;
            case EndpointStartResult::InitializeFailed:
                errorCode = "audio-client-initialize-failed";
                break;
            case EndpointStartResult::CaptureClientFailed:
                errorCode = "capture-client-failed";
                break;
            case EndpointStartResult::AudioEngineStartFailed:
                errorCode = "audio-engine-start-failed";
                break;
            case EndpointStartResult::Cancelled:
                errorCode = "cancelled";
                break;
            default:
                break;
        }

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", errorCode);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // 7. Set state=kCapturing BEFORE mixer_->Start(...)
    state_.store(static_cast<SessionState>(2)); // kCapturing

    // 8. Start mixer with OnCapturePacket callback
    auto mixResult = mixer_->Start([this](const AudioPacket& p) -> bool {
        return OnCapturePacket(p);
    });

    if (!mixResult.success) {
        // Rollback
        endpointSource_->Stop();
        endpointSource_.reset();
        mixer_->RemoveSource(sourceId);
        state_.store(static_cast<SessionState>(0)); // kIdle
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            activeSourceType_ = "";
        }
        streamGeneration_.fetch_sub(1);

        const char* errorCode = "mixer-start-failed";
        switch (mixResult.error) {
            case MultiSourceMixer::StartError::AlreadyRunning:
                errorCode = "mixer-already-running";
                break;
            case MultiSourceMixer::StartError::NoOutputCallback:
                errorCode = "mixer-no-output-callback";
                break;
            case MultiSourceMixer::StartError::ThreadCreationFailed:
                errorCode = "mixer-thread-creation-failed";
                break;
            case MultiSourceMixer::StartError::StaleThreadNotJoined:
                errorCode = "mixer-stale-thread";
                break;
            default: break;
        }
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", errorCode);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // 9. Check mixer is running immediately after successful start
    if (!mixer_->IsRunning()) {
        // Rollback
        endpointSource_->Stop();
        endpointSource_.reset();
        mixer_->Stop();
        mixer_->RemoveSource(sourceId);
        state_.store(static_cast<SessionState>(0)); // kIdle
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            activeSourceType_ = "";
        }
        streamGeneration_.fetch_sub(1);

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", "mixer-stopped-immediately");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // 10. Return success result
    std::string result = "{";
    result += "\"streamGeneration\":" + std::to_string(gen) + ",";
    result += "\"sourceId\":" + std::to_string(sourceId) + ",";
    result += "\"sourceType\":\"endpoint-loopback\",";
    result += "\"endpointReady\":true";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetMixerState(const std::string& /*payload*/,
                                          std::string& response) {
    bool mixerRunning = mixer_ && mixer_->IsRunning();
    uint32_t sourceCount = mixer_ ? mixer_->SourceCount() : 0;

    std::string result = "{";
    result += "\"mixerRunning\":" + std::string(mixerRunning ? "true" : "false") + ",";
    result += "\"sourceCount\":" + std::to_string(sourceCount);
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetMixerDiagnostics(const std::string& /*payload*/,
                                                 std::string& response) {
    if (!mixer_) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "mixer-not-running");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    auto diag = mixer_->GetDiagnostics();

    // Build result JSON
    std::string result = "{";
    result += "\"outputPackets\":" + std::to_string(diag.outputPackets) + ",";
    result += "\"outputFrames\":" + std::to_string(diag.outputFrames) + ",";
    result += "\"silentOutputPackets\":" + std::to_string(diag.silentOutputPackets) + ",";
    result += "\"discontinuities\":" + std::to_string(diag.discontinuities) + ",";
    result += "\"activeSourceCount\":" + std::to_string(diag.activeSourceCount) + ",";
    result += "\"peakSourceCount\":" + std::to_string(diag.peakSourceCount) + ",";
    result += "\"eligibleSessionCount\":" + std::to_string(diag.eligibleSessionCount) + ",";
    result += "\"excludedDiscordCount\":" + std::to_string(diag.excludedDiscordCount) + ",";
    result += "\"excludedScreenLinkCount\":" + std::to_string(diag.excludedScreenLinkCount) + ",";
    result += "\"duplicateRootCount\":" + std::to_string(diag.duplicateRootCount) + ",";
    result += "\"invalidSessionCount\":" + std::to_string(diag.invalidSessionCount) + ",";
    result += "\"sourcesAdded\":" + std::to_string(diag.sourcesAdded) + ",";
    result += "\"sourcesRemoved\":" + std::to_string(diag.sourcesRemoved) + ",";
    result += "\"peakMixLevel\":" + std::to_string(static_cast<double>(diag.peakMixLevel)) + ",";
    result += "\"appliedHeadroomDb\":" + std::to_string(static_cast<double>(diag.appliedHeadroomDb)) + ",";
    result += "\"clippedSamples\":" + std::to_string(diag.clippedSamples) + ",";
    result += "\"limitedBlocks\":" + std::to_string(diag.limitedBlocks) + ",";
    result += "\"maxQueueDepth\":" + std::to_string(diag.maxQueueDepth) + ",";
    result += "\"maxQueueAge100ns\":" + std::to_string(diag.maxQueueAge100ns) + ",";
    result += "\"sourceQueuesAtMax\":" + std::to_string(diag.sourceQueuesAtMax) + ",";

    // Source states
    result += "\"sourceStates\":[";
    for (size_t i = 0; i < diag.sourceStates.size(); ++i) {
        if (i > 0) result += ",";
        const auto& s = diag.sourceStates[i];
        result += "{";
        result += "\"sourceId\":" + std::to_string(s.sourceId) + ",";
        result += "\"pid\":" + std::to_string(s.pid) + ",";
        result += "\"creationTimeUtc100ns\":" + std::to_string(s.creationTimeUtc100ns) + ",";
        result += "\"active\":" + std::string(s.active ? "true" : "false") + ",";
        result += "\"queueDepth\":" + std::to_string(s.queueDepth) + ",";
        result += "\"latePackets\":" + std::to_string(s.latePackets) + ",";
        result += "\"missingPackets\":" + std::to_string(s.missingPackets) + ",";
        result += "\"silentPackets\":" + std::to_string(s.silentPackets) + ",";
        result += "\"discontinuities\":" + std::to_string(s.discontinuities) + ",";
        result += "\"droppedPackets\":" + std::to_string(s.droppedPackets) + ",";
        result += "\"droppedFrames\":" + std::to_string(s.droppedFrames);
        result += "}";
    }
    result += "]}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

// ========================================================================
// Capture Runner Threads
// ========================================================================

void ServiceSession::RunSyntheticCapture(SyntheticConfig cfg) {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);

    SyntheticSource source;
    source.Run(cfg, [this](const AudioPacket& p) -> bool {
        return OnCapturePacket(p);
    });

    // Capture finished — reset state back to idle if we were capturing
    SessionState expected = static_cast<SessionState>(2); // kCapturing
    state_.compare_exchange_strong(expected, static_cast<SessionState>(0)); // kIdle

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_ = "";
    }
}

void ServiceSession::RunProcessCapture(CaptureConfig cfg) {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);

    RunCaptureWithPacketCallback(cfg, [this](const AudioPacket& p) -> bool {
        return OnCapturePacket(p);
    });

    // Capture finished — reset state back to idle
    SessionState expected = static_cast<SessionState>(2); // kCapturing
    state_.compare_exchange_strong(expected, static_cast<SessionState>(0)); // kIdle

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_ = "";
    }
}

// ========================================================================
// StopPhase2EResources
// ========================================================================

void ServiceSession::StopPhase2EResources() {
    // Stop mixer first (stops producing output)
    if (mixer_) {
        mixer_->Stop();
    }

    // Stop all application capture sources
    for (auto& src : captureSources_) {
        if (src) src->Stop();
    }
    captureSources_.clear();

    // Stop endpoint loopback source
    if (endpointSource_) {
        endpointSource_->Stop();
        endpointSource_.reset();
    }

    // Stop session monitor
    if (sessionMonitor_) {
        sessionMonitor_->Stop();
    }
}

// ========================================================================
// OnCapturePacket
// ========================================================================

bool ServiceSession::OnCapturePacket(const AudioPacket& packet) {
    if (state_.load() != static_cast<SessionState>(2)) { // not kCapturing
        onCaptureRejectedState_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    onCaptureAccepted_.fetch_add(1, std::memory_order_relaxed);

    // Convert AudioPacket to PcmPacket
    PcmPacket pcmPacket;
    auto& hdr = pcmPacket.header;

    hdr.flags = 0;
    if (packet.isSilent)          hdr.flags |= kPcmFlagSilent;
    if (packet.isDiscontinuous)   hdr.flags |= kPcmFlagDiscontinuity;
    if (packet.hasTimestampError) hdr.flags |= kPcmFlagTimestampError;
    if (packet.isEndOfStream)     hdr.flags |= kPcmFlagEndOfStream;

    hdr.sequenceNumber = packet.sequenceNumber;
    hdr.qpcTimestamp = packet.qpcPosition100ns;
    // Use actual QPC frequency instead of a hardcoded constant
    hdr.qpcFrequency = SyntheticSource::GetQpcFrequency();
    hdr.devicePosition = packet.devicePosition;
    hdr.sampleRate = 48000;
    hdr.channels = static_cast<uint16_t>(packet.channels);
    hdr.frameCount = packet.frameCount;
    hdr.payloadBytes = packet.frameCount * packet.channels *
                       static_cast<uint32_t>(sizeof(float));
    hdr.streamGeneration = streamGeneration_.load();

    // Copy frame data
    if (packet.frames && packet.frameCount > 0) {
        size_t sampleCount = static_cast<size_t>(packet.frameCount) *
                             packet.channels;
        pcmPacket.payload.assign(packet.frames,
                                 packet.frames + sampleCount);
    }

    totalPackets_.fetch_add(1, std::memory_order_relaxed);
    totalPayloadBytes_.fetch_add(hdr.payloadBytes, std::memory_order_relaxed);
    capturePacketsProduced_.fetch_add(1, std::memory_order_relaxed);
    captureBytesProduced_.fetch_add(hdr.payloadBytes, std::memory_order_relaxed);
    sourcePacketsEnqueued_.fetch_add(1, std::memory_order_relaxed);
    mixerOutputPackets_.fetch_add(1, std::memory_order_relaxed);
    if (!packet.isSilent) {
        mixerNonZeroOutputPackets_.fetch_add(1, std::memory_order_relaxed);
    }

    // Push to queue: always succeeds (drops oldest if full).
    // Dropped packets are counted in pcmWriter_.Queue().DroppedCount().
    pcmWriter_.Queue().Push(std::move(pcmPacket));
    return true; // Always continue — dropped packets are counted but don't stop capture
}

// ========================================================================
// PcmConnectThread
// ========================================================================

void ServiceSession::PcmConnectThread() {
    // PCM writer is handled internally by PcmPipeWriter.
    // This thread monitors connection status.
    while (running_.load()) {
        if (pcmWriter_.IsRunning()) {
            Sleep(1000);
            continue;
        }
        Sleep(100);
    }
}

// ========================================================================
// ParentMonitorThread
// ========================================================================

void ServiceSession::ParentMonitorThread() {
    if (config_.parentPid == 0) return;

    parentProcessHandle_ = static_cast<void*>(
        OpenProcess(SYNCHRONIZE, FALSE, config_.parentPid));
    if (!parentProcessHandle_) return; // Can't monitor, just run

    while (running_.load()) {
        DWORD waitResult = WaitForSingleObject(
            static_cast<HANDLE>(parentProcessHandle_), 1000);
        if (waitResult == WAIT_OBJECT_0) {
            // Parent exited
            running_.store(false);
            break;
        }
    }
}

} // namespace screenlink::audio
