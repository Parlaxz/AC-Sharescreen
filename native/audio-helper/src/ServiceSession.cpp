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
                    resp.Set("result", "{}");
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
                    resp.Set("result", "{}");
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
    resp.Set("result", "{}");
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
    resp.Set("result", result);
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
    resp.Set("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetCapabilities(const std::string& /*payload*/,
                                            std::string& response) {
    auto osInfo = DetectWindowsVersion();
    auto compileTime = DetectCompileTimeSupport();
    auto runtime = DetectRuntimeSupport(osInfo);
    auto cap = ComputeCapability(compileTime, runtime);

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
    result += (runtime.osBuildEligible ? "true" : "false") + std::string(",");
    result += "\"usable\":";
    result += (cap.usable ? "true" : "false") + std::string(",");
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
    resp.Set("result", result);
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
    resp.Set("result", result);
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
        resp.Set("result", "{}");
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
        resp.Set("result", "{}");
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
            resp.Set("result", "{}");
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
    resp.Set("result", result);
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
        resp.Set("result", "{}");
        response = resp.Str();
        return;
    }

    // Check process-loopback support
    if (!IsProcessLoopbackSupported()) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "unsupported-os");
        resp.Set("result", "{}");
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
        resp.Set("result", "{}");
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
    resp.Set("result", result);
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
        resp.Set("result", "{}");
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
    resp.Set("result", result);
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
    result += "\"lastErrorTimestamp\":" + std::to_string(lastErrorTimestamp_);
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(currentState));
    resp.Set("result", result);
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
    resp.Set("result", result);
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
    resp.Set("result", result);
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
        resp.Set("result", "{}");
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
    resp.Set("result", result);
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
        resp.Set("result", "{}");
        response = resp.Str();
        return;
    }

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
        resp.Set("result", "{}");
        response = resp.Str();
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
        resp.Set("result", "{}");
        response = resp.Str();
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
        resp.Set("result", "{}");
        response = resp.Str();
        return;
    }

    uint32_t rootPid = treeResult.applicationRootPid;

    // Create mixer if not already running
    if (!mixer_) {
        mixer_ = std::make_unique<MultiSourceMixer>(48000, static_cast<uint16_t>(2));

        // Start mixer with callback to PCM writer
        mixer_->Start([this](const AudioPacket& p) -> bool {
            return OnCapturePacket(p);
        });

        if (!mixer_->IsRunning()) {
            SimpleJson resp;
            resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
            resp.Set("requestId", static_cast<uint64_t>(0));
            resp.Set("sessionId", config_.sessionId);
            resp.Set("success", false);
            resp.Set("state", StateToStr(static_cast<int>(state_.load())));
            resp.Set("error", "mixer-start-failed");
            resp.Set("result", "{}");
            response = resp.Str();
            return;
        }
    }

    // Add source to mixer
    uint32_t sourceId = mixer_->AddSource(rootPid, actualCreationTime);

    // Start capture source
    auto source = std::make_unique<ApplicationCaptureSource>();
    bool started = source->Start(rootPid, actualCreationTime,
        [this, sourceId](const AudioPacket& p) -> bool {
            mixer_->FeedPacket(sourceId, p);
            return true;
        });

    if (!started) {
        mixer_->RemoveSource(sourceId);
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "capture-start-failed");
        resp.Set("result", "{}");
        response = resp.Str();
        return;
    }

    captureSources_.push_back(std::move(source));

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
    resp.Set("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartFilteredMonitorAudio(const std::string& payload,
                                                       std::string& response) {
    bool excludeDiscord = SimpleJson::GetBool(payload, "excludeDiscord", true);
    bool excludeScreenLink = SimpleJson::GetBool(payload, "excludeScreenLink", true);
    uint32_t screenLinkPid = static_cast<uint32_t>(
        SimpleJson::GetUint(payload, "screenLinkPid", 0));

    // Enumerate audio sessions
    auto monitor = std::make_unique<AudioSessionMonitor>();
    if (!monitor->Initialize()) {
        // Report the precise HRESULT hex code for debugging
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
        resp.Set("result", "{}");
        response = resp.Str();
        return;
    }

    auto sessions = monitor->EnumerateSessions();
    monitor->Stop();

    // Track session count stats
    uint32_t eligibleCount = 0;
    uint32_t excludedDiscordCount = 0;
    uint32_t excludedScreenLinkCount = 0;
    uint32_t duplicateRootCount = 0;
    uint32_t invalidSessionCount = 0;

    // Deduplication: track which application roots we've already added
    struct RootIdentity {
        uint32_t pid;
        uint64_t creationTimeUtc100ns;
        bool operator==(const RootIdentity& o) const {
            return pid == o.pid && creationTimeUtc100ns == o.creationTimeUtc100ns;
        }
    };
    std::vector<RootIdentity> addedRoots;

    // Create mixer if needed
    if (!mixer_) {
        mixer_ = std::make_unique<MultiSourceMixer>(48000, static_cast<uint16_t>(2));
        mixer_->Start([this](const AudioPacket& p) -> bool {
            return OnCapturePacket(p);
        });

        if (!mixer_->IsRunning()) {
            SimpleJson resp;
            resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
            resp.Set("requestId", static_cast<uint64_t>(0));
            resp.Set("sessionId", config_.sessionId);
            resp.Set("success", false);
            resp.Set("state", StateToStr(static_cast<int>(state_.load())));
            resp.Set("error", "mixer-start-failed");
            resp.Set("result", "{}");
            response = resp.Str();
            return;
        }
    }

    // Process each session
    for (const auto& session : sessions) {
        if (session.systemSound || session.pid == 0) {
            invalidSessionCount++;
            continue;
        }

        if (!session.identityValidated) {
            invalidSessionCount++;
            continue;
        }

        // Resolve process tree to find application root
        auto treeResult = ResolveProcessTree(session.pid);
        if (!treeResult.succeeded) {
            invalidSessionCount++;
            continue;
        }

        uint32_t rootPid = treeResult.applicationRootPid;
        uint64_t rootCreationTime = treeResult.targetCreationTimeUtc100ns;

        // Get the root process name for exclusion checks
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
                // Check if this is the ScreenLink PID we should exclude
                bool shouldExclude = true;
                if (screenLinkPid != 0 && rootPid != screenLinkPid) {
                    // Only exclude the specific ScreenLink process if screenLinkPid is given
                    shouldExclude = false;
                }
                if (shouldExclude) {
                    excludedScreenLinkCount++;
                    continue;
                }
            }
        }

        // Deduplicate by root PID + creation time
        RootIdentity identity{rootPid, rootCreationTime};
        bool isDuplicate = false;
        for (const auto& added : addedRoots) {
            if (added == identity) {
                isDuplicate = true;
                break;
            }
        }

        if (isDuplicate) {
            duplicateRootCount++;
            continue;
        }

        eligibleCount++;

        // Add source to mixer
        uint32_t sourceId = mixer_->AddSource(rootPid, rootCreationTime);

        // Start capture source
        auto source = std::make_unique<ApplicationCaptureSource>();
        bool started = source->Start(rootPid, rootCreationTime,
            [this, sourceId](const AudioPacket& p) -> bool {
                mixer_->FeedPacket(sourceId, p);
                return true;
            });

        if (started) {
            addedRoots.push_back(identity);
            captureSources_.push_back(std::move(source));
        }
    }

    // Update mixer diagnostics with session counts
    {
        auto diag = mixer_->GetDiagnostics();
        // The diag fields are populated snapshot-based; we update our counters
        // in the response directly rather than modifying mixer state.
    }

    uint32_t activeSourceCount = mixer_->SourceCount();

    std::string result = "{";
    result += "\"totalSessions\":" + std::to_string(sessions.size()) + ",";
    result += "\"eligibleCount\":" + std::to_string(eligibleCount) + ",";
    result += "\"excludedDiscordCount\":" + std::to_string(excludedDiscordCount) + ",";
    result += "\"excludedScreenLinkCount\":" + std::to_string(excludedScreenLinkCount) + ",";
    result += "\"duplicateRootCount\":" + std::to_string(duplicateRootCount) + ",";
    result += "\"invalidSessionCount\":" + std::to_string(invalidSessionCount) + ",";
    result += "\"activeSourceCount\":" + std::to_string(activeSourceCount);
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.Set("result", result);
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
    resp.Set("result", result);
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
        resp.Set("result", "{}");
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
    resp.Set("result", result);
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

    // Stop session monitor
    if (sessionMonitor_) {
        sessionMonitor_->Stop();
    }
}

// ========================================================================
// OnCapturePacket
// ========================================================================

bool ServiceSession::OnCapturePacket(const AudioPacket& packet) {
    if (state_.load() != static_cast<SessionState>(2)) return false; // not kCapturing

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
