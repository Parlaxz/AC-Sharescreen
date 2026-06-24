#include "ServiceSession.h"
#include "AudioCapabilities.h"
#include "WindowsVersion.h"
#include "Protocol.h"
#include "ExclusionPolicy.h"
#include "ProcessResolver.h"
#include "SourceMapper.h"
#include "FilteredMonitorController.h"

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

/// Strictly parse a decimal string as uint64_t. Returns true on success.
/// Rejects empty strings, non-digit characters, overflow, and partial consumption.
static bool ParseUint64DecimalString(
    const std::string& json,
    const char* key,
    uint64_t& value)
{
    const std::string text = SimpleJson::GetString(json, key);
    if (text.empty()) {
        value = 0;
        return false;
    }

    for (unsigned char c : text) {
        if (c < '0' || c > '9') {
            value = 0;
            return false;
        }
    }

    try {
        size_t consumed = 0;
        unsigned long long parsed = std::stoull(text, &consumed, 10);
        if (consumed != text.size()) {
            value = 0;
            return false;
        }
        value = static_cast<uint64_t>(parsed);
        return true;
    } catch (...) {
        value = 0;
        return false;
    }
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

    // Stop all audio resources before joining threads
    StopAudioResources();

    // Join threads
    if (captureThread_.joinable()) captureThread_.join();
    if (controlThread_.joinable()) controlThread_.join();
    if (pcmConnectThread_.joinable()) pcmConnectThread_.join();
    if (monitorThread_.joinable()) monitorThread_.join();

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
                CommandContext ctx;
                ctx.requestId = requestId;
                ctx.sessionId = sessionId;
                std::string response;
                bool recognised = DispatchCommand(ctx, command, payload, response);

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

bool ServiceSession::DispatchCommand(const CommandContext& ctx,
                                      const std::string& command,
                                      const std::string& payload,
                                      std::string& response) {
    if (command == "hello") {
        HandleHello(ctx, payload, response);
        return true;
    } else if (command == "getVersion" || command == "getversion") {
        HandleGetVersion(ctx, payload, response);
        return true;
    } else if (command == "getCapabilities" || command == "getcapabilities") {
        HandleGetCapabilities(ctx, payload, response);
        return true;
    } else if (command == "getState" || command == "getstate") {
        HandleGetState(ctx, payload, response);
        return true;
    } else if (command == "startSynthetic" || command == "startsynthetic") {
        HandleStartSynthetic(ctx, payload, response);
        return true;
    } else if (command == "startProcessCapture" ||
               command == "startprocesscapture") {
        HandleStartProcessCapture(ctx, payload, response);
        return true;
    } else if (command == "stopCapture" || command == "stopcapture") {
        HandleStopCapture(ctx, payload, response);
        return true;
    } else if (command == "getDiagnostics" || command == "getdiagnostics") {
        HandleGetDiagnostics(ctx, payload, response);
        return true;
    } else if (command == "ping") {
        HandlePing(ctx, payload, response);
        return true;
    } else if (command == "shutdown") {
        HandleShutdown(ctx, payload, response);
        return true;
    } else if (command == "resolveSource" ||
               command == "resolvesource") {
        HandleResolveSource(ctx, payload, response);
        return true;
    } else if (command == "enumerateAudioSessions" ||
               command == "enumerateaudiosessions") {
        HandleEnumerateAudioSessions(ctx, payload, response);
        return true;
    } else if (command == "startApplicationAudio" ||
               command == "startapplicationaudio") {
        HandleStartApplicationAudio(ctx, payload, response);
        return true;
    } else if (command == "startFilteredMonitorAudio" ||
               command == "startfilteredmonitoraudio") {
        HandleStartFilteredMonitorAudio(ctx, payload, response);
        return true;
    } else if (command == "getMixerState" ||
               command == "getmixerstate") {
        HandleGetMixerState(ctx, payload, response);
        return true;
    } else if (command == "getMixerDiagnostics" ||
               command == "getmixerdiagnostics") {
        HandleGetMixerDiagnostics(ctx, payload, response);
        return true;
    } else if (command == "startEndpointLoopback" ||
               command == "startendpointloopback") {
        HandleStartEndpointLoopback(ctx, payload, response);
        return true;
    } else if (command == "getEndpointDiagnostics" || command == "getendpointdiagnostics") {
        HandleGetEndpointDiagnostics(ctx, payload, response);
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

std::string ServiceSession::MakeErrorResponse(const CommandContext& ctx, const std::string& errorCode) {
    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
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

void ServiceSession::HandleHello(const CommandContext& ctx,
                                   const std::string& /*payload*/,
                                   std::string& response) {
    std::string result = "{";
    result += "\"helperVersion\":\"" + std::string(kHelperVersion) + "\",";
    result += "\"protocolVersion\":\"" + std::string(kServiceProtocolVersion) + "\",";
    result += "\"sessionId\":\"" + config_.sessionId + "\",";
    result += "\"pid\":" + std::to_string(static_cast<uint64_t>(GetCurrentProcessId()));
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetVersion(const CommandContext& ctx,
                                        const std::string& /*payload*/,
                                        std::string& response) {
    std::string result = "{";
    result += "\"helperVersion\":\"" + std::string(kHelperVersion) + "\",";
    result += "\"protocolVersion\":\"" + std::string(kServiceProtocolVersion) + "\"";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetCapabilities(const CommandContext& ctx,
                                             const std::string& /*payload*/,
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
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetState(const CommandContext& ctx,
                                      const std::string& /*payload*/,
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
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(currentState));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartSynthetic(const CommandContext& ctx,
                                            const std::string& payload,
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
        resp.Set("requestId", ctx.requestId);
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
        resp.Set("requestId", ctx.requestId);
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
            SimpleJson resp;
            resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
            resp.Set("requestId", ctx.requestId);
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
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartProcessCapture(const CommandContext& ctx,
                                                  const std::string& payload,
                                                  std::string& response) {
    // Parse payload
    int64_t targetPid = SimpleJson::GetInt(payload, "targetPid", 0);

    // Parse creation time with strict uint64 decimal string helper
    uint64_t expectedCreationTime = 0;
    ParseUint64DecimalString(payload, "expectedCreationTimeUtc100ns", expectedCreationTime);

    std::string mode = SimpleJson::GetString(payload, "mode");
    bool includeMode = (mode != "exclude");

    if (targetPid <= 0) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
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
        resp.Set("requestId", ctx.requestId);
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
        resp.Set("requestId", ctx.requestId);
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
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStopCapture(const CommandContext& ctx,
                                         const std::string& /*payload*/,
                                         std::string& response) {
    int previousState = static_cast<int>(state_.load());

    if (previousState != 2 && previousState != 1) { // kCapturing, kStarting
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
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

    // Stop audio capture resources
    StopAudioResources();

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
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "idle");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetDiagnostics(const CommandContext& ctx,
                                            const std::string& /*payload*/,
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
    // Bridge filtered monitor controller diagnostics when active
    if (activeSrc == "monitor" && filteredMonitor_) {
        auto monDiag = filteredMonitor_->GetDiagnostics();
        result += "\"mixerFeedPackets\":" + std::to_string(monDiag.mixerInputPackets) + ",";
        result += "\"mixerOutputPackets\":" + std::to_string(monDiag.mixerOutputPackets) + ",";
        result += "\"mixerNonZeroOutputPackets\":" + std::to_string(monDiag.mixerOutputNonZeroPackets) + ",";
    } else {
        result += "\"mixerFeedPackets\":" + std::to_string(mixerFeedPackets_.load()) + ",";
        result += "\"mixerOutputPackets\":" + std::to_string(mixerOutputPackets_.load()) + ",";
        result += "\"mixerNonZeroOutputPackets\":" + std::to_string(mixerNonZeroOutputPackets_.load()) + ",";
    }
    result += "\"onCaptureAccepted\":" + std::to_string(onCaptureAccepted_.load()) + ",";
    result += "\"onCaptureRejectedState\":" + std::to_string(onCaptureRejectedState_.load());

    // Include filtered monitor diagnostics inline when active
    if (activeSrc == "monitor" && filteredMonitor_) {
        auto monDiag = filteredMonitor_->GetDiagnostics();
        result += ",\"filteredMonitorDiagnostics\":{";
        result += "\"running\":" + std::string(monDiag.running ? "true" : "false") + ",";
        result += "\"monitorInitialized\":" + std::string(monDiag.monitorInitialized ? "true" : "false") + ",";
        result += "\"activeCaptureSources\":" + std::to_string(monDiag.activeCaptureSources) + ",";
        result += "\"totalSessionsLastScan\":" + std::to_string(monDiag.totalSessionsLastScan) + ",";
        result += "\"desiredSourcesLastScan\":" + std::to_string(monDiag.desiredSourcesLastScan) + ",";
        result += "\"sourcesAdded\":" + std::to_string(monDiag.sourcesAdded) + ",";
        result += "\"sourcesRemoved\":" + std::to_string(monDiag.sourcesRemoved) + ",";
        result += "\"sourceStartFailures\":" + std::to_string(monDiag.sourceStartFailures) + ",";
        result += "\"sourceRetries\":" + std::to_string(monDiag.sourceRetries) + ",";
        result += "\"duplicateRootsLastScan\":" + std::to_string(monDiag.duplicateRootsLastScan) + ",";
        result += "\"validatedLiveSessionsLastScan\":" + std::to_string(monDiag.validatedLiveSessionsLastScan) + ",";
        result += "\"inconsistentIdentitySessionsLastScan\":" + std::to_string(monDiag.inconsistentIdentitySessionsLastScan) + ",";
        result += "\"identityLookupFailuresLastScan\":" + std::to_string(monDiag.identityLookupFailuresLastScan) + ",";
        result += "\"mixerInputPackets\":" + std::to_string(monDiag.mixerInputPackets) + ",";
        result += "\"mixerInputNonZeroPackets\":" + std::to_string(monDiag.mixerInputNonZeroPackets) + ",";
        result += "\"mixerInputZeroPackets\":" + std::to_string(monDiag.mixerInputZeroPackets) + ",";
        result += "\"lastInputPeak\":" + std::to_string(static_cast<double>(monDiag.lastInputPeak)) + ",";
        result += "\"maximumInputPeak\":" + std::to_string(static_cast<double>(monDiag.maximumInputPeak)) + ",";
        result += "\"lastInputRms\":" + std::to_string(monDiag.lastInputRms) + ",";
        result += "\"maximumInputRms\":" + std::to_string(monDiag.maximumInputRms) + ",";
        result += "\"mixerOutputPackets\":" + std::to_string(monDiag.mixerOutputPackets) + ",";
        result += "\"mixerOutputNonZeroPackets\":" + std::to_string(monDiag.mixerOutputNonZeroPackets) + ",";
        result += "\"mixerOutputZeroPackets\":" + std::to_string(monDiag.mixerOutputZeroPackets) + ",";
        result += "\"lastOutputPeak\":" + std::to_string(static_cast<double>(monDiag.lastOutputPeak)) + ",";
        result += "\"maximumOutputPeak\":" + std::to_string(static_cast<double>(monDiag.maximumOutputPeak)) + ",";
        result += "\"lastOutputRms\":" + std::to_string(monDiag.lastOutputRms) + ",";
        result += "\"maximumOutputRms\":" + std::to_string(monDiag.maximumOutputRms) + ",";
        result += "\"lastErrorCode\":\"" + monDiag.lastErrorCode + "\",";
        result += "\"lastErrorMessage\":\"" + monDiag.lastErrorMessage + "\",";

        // Serialize active sources
        result += "\"activeSources\":[";
        for (size_t i = 0; i < monDiag.activeSources.size(); ++i) {
            if (i > 0) result += ",";
            const auto& src = monDiag.activeSources[i];
            result += "{";
            result += "\"sessionPid\":" + std::to_string(src.sessionPid) + ",";
            result += "\"logicalRootPid\":" + std::to_string(src.logicalRootPid) + ",";
            result += "\"physicalCaptureTargetPid\":" + std::to_string(src.physicalCaptureTargetPid) + ",";
            result += "\"executableName\":\"" + src.executableName + "\",";
            result += "\"inputPackets\":" + std::to_string(src.inputPackets) + ",";
            result += "\"inputNonZeroPackets\":" + std::to_string(src.inputNonZeroPackets) + ",";
            result += "\"maximumInputPeak\":" + std::to_string(static_cast<double>(src.maximumInputPeak));
            result += "}";
        }
        result += "]";

        result += "}";
    }

    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(currentState));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandlePing(const CommandContext& ctx,
                                  const std::string& /*payload*/,
                                  std::string& response) {
    auto uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - startTime_).count();

    std::string result = "{";
    result += "\"uptimeMs\":" + std::to_string(static_cast<uint64_t>(uptime));
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleShutdown(const CommandContext& ctx,
                                      const std::string& /*payload*/,
                                      std::string& response) {
    // If capturing, stop first
    if (state_.load() == static_cast<SessionState>(2)) { // kCapturing
        state_.store(static_cast<SessionState>(3)); // kStopping
        if (captureThread_.joinable()) {
            captureThread_.join();
        }
        state_.store(static_cast<SessionState>(0)); // kIdle
    }

    // Stop audio capture resources
    StopAudioResources();

    std::string result = "{";
    result += "\"exitCode\":0";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "idle");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

// ========================================================================
// HandleResolveSource — resolve a desktop-capture source ID
//
// IMPORTANT: Every untrusted or Windows-derived string MUST go through
// SimpleJson::Set which escapes quotes, backslashes, newlines, tabs,
// and control characters. Do NOT manually concatenate JSON strings with
// Windows paths — backslashes like \P and \V produce invalid JSON.
// SetRaw is only for JSON objects already produced by a JSON builder.
// ========================================================================

void ServiceSession::HandleResolveSource(const CommandContext& ctx,
                                           const std::string& payload,
                                           std::string& response) {
    const std::string sourceId = SimpleJson::GetString(payload, "sourceId");

    if (sourceId.empty()) {
        SimpleJson result;
        result.Set("found", false);
        result.Set("error", "invalid-source-id");

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", true);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.SetRaw("result", result.Str());
        resp.Set("error", "null");
        response = resp.Str();
        return;
    }

    const auto resolved = ResolveDesktopCapturerSource(sourceId);

    if (!resolved.found) {
        SimpleJson result;
        result.Set("found", false);
        result.Set("error", resolved.error);

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", true);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.SetRaw("result", result.Str());
        resp.Set("error", "null");
        response = resp.Str();
        return;
    }

    uint32_t capturePid = resolved.source.processId;
    uint64_t captureCreationTime = resolved.source.processCreationTimeUtc100ns;

    const auto tree = ResolveProcessTree(resolved.source.processId);
    if (tree.succeeded && tree.applicationRootPid != 0) {
        capturePid = tree.applicationRootPid;
        // Use GetProcessCreationTime for the resolved root PID rather
        // than reusing the target's time (they may differ).
        captureCreationTime = GetProcessCreationTime(capturePid);
    }

    // Use SimpleJson builders throughout — avoids manual JSON concatenation
    // that would not properly escape Windows paths, newlines, or control chars.
    SimpleJson source;
    source.Set("sourceId", resolved.source.sourceId);
    source.Set("pid", static_cast<uint64_t>(resolved.source.processId));
    source.Set("capturePid", static_cast<uint64_t>(capturePid));

    // Transport FILETIME values as decimal strings (exceed Number.MAX_SAFE_INTEGER)
    source.Set("processCreationTimeUtc100ns",
               std::to_string(resolved.source.processCreationTimeUtc100ns));
    source.Set("captureCreationTimeUtc100ns",
               std::to_string(captureCreationTime));
    source.Set("applicationRootPid", static_cast<uint64_t>(capturePid));
    source.Set("applicationRootCreationTimeUtc100ns",
               std::to_string(captureCreationTime));

    source.Set("processName", resolved.source.processName);
    source.Set("processPath", resolved.source.processPath);
    source.Set("windowTitle", resolved.source.windowTitle);
    source.Set("displayName", resolved.source.displayName);
    source.Set("hwnd", resolved.source.hwnd);
    source.Set("isElectron", resolved.source.isElectron);
    source.Set("hasAudio", resolved.source.hasAudio);

    SimpleJson result;
    result.Set("found", true);
    result.SetRaw("source", source.Str());

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result.Str());
    resp.Set("error", "null");

    response = resp.Str();
}

// ========================================================================
// Phase 2E — Multi-source audio mixer handlers
// ========================================================================

void ServiceSession::HandleEnumerateAudioSessions(const CommandContext& ctx,
                                                     const std::string& /*payload*/,
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
        resp.Set("requestId", ctx.requestId);
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
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartApplicationAudio(const CommandContext& ctx,
                                                    const std::string& payload,
                                                    std::string& response) {
    // Parse payload
    int64_t targetPid = SimpleJson::GetInt(payload, "targetPid", 0);

    // Parse creation time with strict uint64 decimal string helper
    uint64_t expectedCreationTime = 0;
    ParseUint64DecimalString(payload, "expectedCreationTimeUtc100ns", expectedCreationTime);

    if (targetPid <= 0) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
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
        resp.Set("requestId", ctx.requestId);
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
        resp.Set("requestId", ctx.requestId);
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
        resp.Set("requestId", ctx.requestId);
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
        resp.Set("requestId", ctx.requestId);
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "process-loopback-unsupported");
        resp.SetRaw("result", result);
        response = resp.Str();
        state_.store(SessionState::kIdle);
        return;
    }

    // Application Audio has exactly one source — no MultiSourceMixer needed.
    // Start the ApplicationCaptureSource directly with OnCapturePacket.
    // Bypassing the mixer avoids its 10ms fixed-timestamp-window alignment,
    // which can discard WASAPI packets with different timing.

    const uint32_t gen = streamGeneration_.fetch_add(1, std::memory_order_acq_rel) + 1;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_ = "application";
    }

    // Set kCapturing before source Start so OnCapturePacket accepts output.
    state_.store(SessionState::kCapturing, std::memory_order_release);

    std::cerr << "[ProcessLoopback] activate targetPid=" << rootPid
              << " mode=include-tree source=application"
              << " sessionPid=" << targetPid
              << " executableName=" << treeResult.applicationRootName
              << std::endl;

    auto source = std::make_unique<ApplicationCaptureSource>();
    auto startOutcome = source->Start(rootPid, actualCreationTime,
        [this](const AudioPacket& packet) -> bool {
            return OnCapturePacket(packet);
        });

    if (startOutcome.result != AppCaptureStartResult::Success) {
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            activeSourceType_.clear();
        }
        state_.store(SessionState::kIdle, std::memory_order_release);

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", "capture-start-failed");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    applicationSource_ = std::move(source);

    SimpleJson result;
    result.Set("streamGeneration", static_cast<uint64_t>(gen));
    result.Set("rootPid", static_cast<uint64_t>(rootPid));
    result.Set("rootName", treeResult.applicationRootName);
    result.Set("sourceType", "application");
    result.Set("directSource", true);

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result.Str());
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartFilteredMonitorAudio(const CommandContext& ctx,
                                                        const std::string& payload,
                                                        std::string& response) {
    // Parse options from payload
    bool excludeDiscord = SimpleJson::GetBool(payload, "excludeDiscord", true);
    bool excludeScreenLink = SimpleJson::GetBool(payload, "excludeScreenLink", true);
    uint32_t screenLinkPid = static_cast<uint32_t>(
        SimpleJson::GetUint(payload, "screenLinkPid", 0));

    // Lock audio lifecycle mutex to serialize start/stop transitions
    std::lock_guard<std::mutex> lock(audioLifecycleMutex_);

    // Require idle state
    if (state_.load() != SessionState::kIdle) {
        response = MakeErrorResponse(ctx, "already-capturing");
        return;
    }

    // Wait for PCM connection
    {
        int waitCount = 0;
        while (!pcmWriter_.IsClientConnected() && waitCount < 100) {
            Sleep(10);
            waitCount++;
        }
        if (!pcmWriter_.IsClientConnected()) {
            response = MakeErrorResponse(ctx, "pcm-not-connected");
            return;
        }
    }

    // Set state to kStarting and allocate stream generation
    state_.store(SessionState::kStarting);
    const uint32_t gen = streamGeneration_.fetch_add(1, std::memory_order_acq_rel) + 1;

    {
        std::lock_guard<std::mutex> stateLock(stateMutex_);
        activeSourceType_ = "monitor";
    }

    // Construct FilteredMonitorController
    auto controller = std::make_unique<FilteredMonitorController>();

    // Set state to kCapturing before native callbacks may begin
    state_.store(SessionState::kCapturing, std::memory_order_release);

    // Configure options
    FilteredMonitorOptions options;
    options.excludeDiscord = excludeDiscord;
    options.excludeScreenLink = excludeScreenLink;
    options.screenLinkPid = screenLinkPid;

    // Start controller with OnCapturePacket callback
    auto outcome = controller->Start(options,
        [this](const AudioPacket& packet) -> bool {
            return OnCapturePacket(packet);
        });

    if (!outcome.success) {
        // Transition through stopping back to idle
        state_.store(SessionState::kStopping, std::memory_order_release);
        controller->Stop();
        controller.reset();
        {
            std::lock_guard<std::mutex> stateLock(stateMutex_);
            activeSourceType_.clear();
        }
        state_.store(SessionState::kIdle, std::memory_order_release);

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", outcome.errorCode.empty() ? "capture-start-failed" : outcome.errorCode.c_str());
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // Transfer ownership
    filteredMonitor_ = std::move(controller);

    // Build result
    SimpleJson result;
    result.Set("streamGeneration", static_cast<uint64_t>(gen));
    result.Set("sourceType", "monitor");
    result.Set("pipeline", "dynamic-process-mix");
    result.Set("initialActiveSources", static_cast<uint64_t>(outcome.initialActiveSources));

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result.Str());
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleStartEndpointLoopback(const CommandContext& ctx,
                                                    const std::string& /*payload*/,
                                                    std::string& response) {
    // Lock audio lifecycle mutex to serialize start/stop transitions
    std::lock_guard<std::mutex> lock(audioLifecycleMutex_);

    // Require idle state
    if (state_.load() != SessionState::kIdle) {
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "already-capturing");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // Wait for PCM connection
    {
        int waitCount = 0;
        while (!pcmWriter_.IsClientConnected() && waitCount < 100) {
            Sleep(10);
            waitCount++;
        }
        if (!pcmWriter_.IsClientConnected()) {
            SimpleJson resp;
            resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
            resp.Set("requestId", ctx.requestId);
            resp.Set("sessionId", config_.sessionId);
            resp.Set("success", false);
            resp.Set("state", "idle");
            resp.Set("error", "pcm-not-connected");
            resp.SetRaw("result", "{}");
            response = resp.Str();
            return;
        }
    }

    // Set state to kStarting and allocate stream generation
    state_.store(SessionState::kStarting);
    const uint32_t gen = streamGeneration_.fetch_add(1, std::memory_order_acq_rel) + 1;

    {
        std::lock_guard<std::mutex> stateLock(stateMutex_);
        activeSourceType_ = "endpoint-loopback";
    }

    // Construct EndpointLoopbackSource
    auto source = std::make_unique<EndpointLoopbackSource>();

    // Set state to kCapturing before source Start so OnCapturePacket accepts output
    state_.store(SessionState::kCapturing, std::memory_order_release);

    // Start with direct OnCapturePacket callback (no mixer)
    auto startOutcome = source->Start(
        [this](const AudioPacket& p) -> bool {
            // Track endpoint diagnostics
            endpointPacketsCaptured_.fetch_add(1, std::memory_order_relaxed);

            if (p.isSilent) {
                endpointSilentPackets_.fetch_add(1, std::memory_order_relaxed);
            } else {
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

            // Directly call OnCapturePacket — no mixer
            return OnCapturePacket(p);
        });

    if (startOutcome.result != EndpointStartResult::Success) {
        // Transition through stopping back to idle
        state_.store(SessionState::kStopping, std::memory_order_release);
        source->Stop();
        source.reset();
        {
            std::lock_guard<std::mutex> stateLock(stateMutex_);
            activeSourceType_.clear();
        }
        state_.store(SessionState::kIdle, std::memory_order_release);

        const char* errorCode = "capture-start-failed";
        switch (startOutcome.result) {
            case EndpointStartResult::ComInitFailed:
                errorCode = "com-init-failed"; break;
            case EndpointStartResult::EnumeratorFailed:
                errorCode = "enumerator-failed"; break;
            case EndpointStartResult::EndpointNotFound:
                errorCode = "endpoint-not-found"; break;
            case EndpointStartResult::AudioClientActivationFailed:
                errorCode = "audio-client-activation-failed"; break;
            case EndpointStartResult::GetMixFormatFailed:
                errorCode = "get-mix-format-failed"; break;
            case EndpointStartResult::InitializeFailed:
                errorCode = "audio-client-initialize-failed"; break;
            case EndpointStartResult::CaptureClientFailed:
                errorCode = "capture-client-failed"; break;
            case EndpointStartResult::AudioEngineStartFailed:
                errorCode = "audio-engine-start-failed"; break;
            case EndpointStartResult::Cancelled:
                errorCode = "cancelled"; break;
            default: break;
        }

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", ctx.requestId);
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", errorCode);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // Transfer ownership
    endpointSource_ = std::move(source);

    // Return success result
    SimpleJson result;
    result.Set("streamGeneration", static_cast<uint64_t>(gen));
    result.Set("sourceType", "system");
    result.Set("pipeline", "endpoint-direct");
    result.Set("sampleRate", static_cast<uint64_t>(48000));
    result.Set("channels", static_cast<uint64_t>(2));

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result.Str());
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetMixerState(const CommandContext& ctx,
                                            const std::string& /*payload*/,
                                            std::string& response) {
    std::string activeSrc;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSrc = activeSourceType_;
    }

    std::string result;
    if (activeSrc == "monitor" && filteredMonitor_) {
        result = "{";
        result += "\"sourceType\":\"monitor\",";
        result += "\"pipeline\":\"filtered-monitor\",";
        result += "\"running\":" + std::string(filteredMonitor_->IsRunning() ? "true" : "false");
        result += "}";
    } else if (activeSrc == "application" && applicationSource_) {
        result = "{";
        result += "\"sourceType\":\"application\",";
        result += "\"pipeline\":\"application-direct\",";
        result += "\"running\":" + std::string(applicationSource_->IsRunning() ? "true" : "false");
        result += "}";
    } else if (activeSrc == "endpoint-loopback" && endpointSource_) {
        result = "{";
        result += "\"sourceType\":\"system\",";
        result += "\"pipeline\":\"endpoint-direct\",";
        result += "\"running\":" + std::string(endpointSource_->IsRunning() ? "true" : "false");
        result += "}";
    } else {
        result = "{";
        result += "\"sourceType\":\"none\",";
        result += "\"pipeline\":\"idle\",";
        result += "\"running\":false";
        result += "}";
    }

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

void ServiceSession::HandleGetMixerDiagnostics(const CommandContext& ctx,
                                                   const std::string& /*payload*/,
                                                   std::string& response) {
    std::string activeSrc;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSrc = activeSourceType_;
    }

    std::string result;
    if (activeSrc == "monitor" && filteredMonitor_) {
        // Return filtered controller diagnostics
        auto diag = filteredMonitor_->GetDiagnostics();

        result = "{";
        result += "\"sourceType\":\"monitor\",";
        result += "\"pipeline\":\"dynamic-process-mix\",";
        result += "\"running\":" + std::string(diag.running ? "true" : "false") + ",";
        result += "\"mixerRunning\":" + std::string(diag.mixerRunning ? "true" : "false") + ",";
        result += "\"totalReconciliations\":" + std::to_string(diag.totalReconciliations) + ",";
        result += "\"activeCaptureSources\":" + std::to_string(diag.activeCaptureSources) + ",";
        result += "\"sourcesAdded\":" + std::to_string(diag.sourcesAdded) + ",";
        result += "\"sourcesRemoved\":" + std::to_string(diag.sourcesRemoved) + ",";
        result += "\"totalSessionsLastScan\":" + std::to_string(diag.totalSessionsLastScan) + ",";
        result += "\"activeSessionsLastScan\":" + std::to_string(diag.activeSessionsLastScan) + ",";
        result += "\"inactiveSessionsLastScan\":" + std::to_string(diag.inactiveSessionsLastScan) + ",";
        result += "\"desiredSourcesLastScan\":" + std::to_string(diag.desiredSourcesLastScan) + ",";
        result += "\"invalidSessionsLastScan\":" + std::to_string(diag.invalidSessionsLastScan) + ",";
        result += "\"expiredSessionsLastScan\":" + std::to_string(diag.expiredSessionsLastScan) + ",";
        result += "\"systemSoundsSkippedLastScan\":" + std::to_string(diag.systemSoundsSkippedLastScan) + ",";
        result += "\"discordExcludedLastScan\":" + std::to_string(diag.discordExcludedLastScan) + ",";
        result += "\"screenLinkExcludedLastScan\":" + std::to_string(diag.screenLinkExcludedLastScan) + ",";
        result += "\"duplicateRootsLastScan\":" + std::to_string(diag.duplicateRootsLastScan) + ",";
        result += "\"validatedLiveSessionsLastScan\":" + std::to_string(diag.validatedLiveSessionsLastScan) + ",";
        result += "\"inconsistentIdentitySessionsLastScan\":" + std::to_string(diag.inconsistentIdentitySessionsLastScan) + ",";
        result += "\"identityLookupFailuresLastScan\":" + std::to_string(diag.identityLookupFailuresLastScan) + ",";
        result += "\"sourceStartAttempts\":" + std::to_string(diag.sourceStartAttempts) + ",";
        result += "\"sourceStartFailures\":" + std::to_string(diag.sourceStartFailures) + ",";
        result += "\"sourceRetries\":" + std::to_string(diag.sourceRetries) + ",";
        result += "\"sourceUnexpectedStops\":" + std::to_string(diag.sourceUnexpectedStops) + ",";
        result += "\"mixerInputPackets\":" + std::to_string(diag.mixerInputPackets) + ",";
        result += "\"mixerInputNonZeroPackets\":" + std::to_string(diag.mixerInputNonZeroPackets) + ",";
        result += "\"mixerInputZeroPackets\":" + std::to_string(diag.mixerInputZeroPackets) + ",";
        result += "\"lastInputPeak\":" + std::to_string(static_cast<double>(diag.lastInputPeak)) + ",";
        result += "\"maximumInputPeak\":" + std::to_string(static_cast<double>(diag.maximumInputPeak)) + ",";
        result += "\"lastInputRms\":" + std::to_string(diag.lastInputRms) + ",";
        result += "\"maximumInputRms\":" + std::to_string(diag.maximumInputRms) + ",";
        result += "\"mixerOutputPackets\":" + std::to_string(diag.mixerOutputPackets) + ",";
        result += "\"mixerOutputNonZeroPackets\":" + std::to_string(diag.mixerOutputNonZeroPackets) + ",";
        result += "\"mixerOutputZeroPackets\":" + std::to_string(diag.mixerOutputZeroPackets) + ",";
        result += "\"lastOutputPeak\":" + std::to_string(static_cast<double>(diag.lastOutputPeak)) + ",";
        result += "\"maximumOutputPeak\":" + std::to_string(static_cast<double>(diag.maximumOutputPeak)) + ",";
        result += "\"lastOutputRms\":" + std::to_string(diag.lastOutputRms) + ",";
        result += "\"maximumOutputRms\":" + std::to_string(diag.maximumOutputRms) + ",";
        result += "\"lastErrorCode\":\"" + diag.lastErrorCode + "\",";
        result += "\"lastErrorMessage\":\"" + diag.lastErrorMessage + "\",";

        // Serialize active sources
        result += "\"activeSources\":[";
        for (size_t i = 0; i < diag.activeSources.size(); ++i) {
            if (i > 0) result += ",";
            const auto& src = diag.activeSources[i];
            result += "{";
            result += "\"sessionPid\":" + std::to_string(src.sessionPid) + ",";
            result += "\"logicalRootPid\":" + std::to_string(src.logicalRootPid) + ",";
            result += "\"physicalCaptureTargetPid\":" + std::to_string(src.physicalCaptureTargetPid) + ",";
            result += "\"executableName\":\"" + src.executableName + "\",";
            result += "\"inputPackets\":" + std::to_string(src.inputPackets) + ",";
            result += "\"inputNonZeroPackets\":" + std::to_string(src.inputNonZeroPackets) + ",";
            result += "\"maximumInputPeak\":" + std::to_string(static_cast<double>(src.maximumInputPeak));
            result += "}";
        }
        result += "]";

        result += "}";
    } else if (activeSrc == "application" && applicationSource_) {
        result = "{";
        result += "\"sourceType\":\"application\",";
        result += "\"pipeline\":\"application-direct\",";
        result += "\"running\":" + std::string(applicationSource_->IsRunning() ? "true" : "false") + ",";
        result += "\"packets\":" + std::to_string(appAudioDiag_.packets.load()) + ",";
        result += "\"frames\":" + std::to_string(appAudioDiag_.frames.load()) + ",";
        result += "\"nonZeroPackets\":" + std::to_string(appAudioDiag_.nonZeroPackets.load()) + ",";
        result += "\"peak\":" + std::to_string(static_cast<double>(appAudioDiag_.peak.load()));
        result += "}";
    } else if (activeSrc == "endpoint-loopback" && endpointSource_) {
        auto diag = endpointSource_->GetDiagnostics();
        result = "{";
        result += "\"sourceType\":\"system\",";
        result += "\"pipeline\":\"endpoint-direct\",";
        result += "\"running\":" + std::string(diag.running ? "true" : "false") + ",";
        result += "\"packetsCaptured\":" + std::to_string(diag.packetsCaptured) + ",";
        result += "\"nonZeroPackets\":" + std::to_string(diag.nonZeroPackets) + ",";
        result += "\"silentPackets\":" + std::to_string(diag.silentPackets);
        result += "}";
    } else {
        result = "{";
        result += "\"sourceType\":\"none\",";
        result += "\"pipeline\":\"idle\"";
        result += "}";
    }

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", StateToStr(static_cast<int>(state_.load())));
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}

// ========================================================================
// HandleGetEndpointDiagnostics
// ========================================================================

void ServiceSession::HandleGetEndpointDiagnostics(const CommandContext& ctx,
                                                    const std::string& /*payload*/,
                                                    std::string& response) {
    std::string activeSrc;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSrc = activeSourceType_;
    }

    std::string result;
    if (activeSrc == "endpoint-loopback" && endpointSource_) {
        auto diag = endpointSource_->GetDiagnostics();
        result = "{";
        result += "\"running\":" + std::string(diag.running ? "true" : "false") + ",";
        result += "\"packetsCaptured\":" + std::to_string(diag.packetsCaptured) + ",";
        result += "\"nonZeroPackets\":" + std::to_string(diag.nonZeroPackets) + ",";
        result += "\"silentPackets\":" + std::to_string(diag.silentPackets) + ",";
        result += "\"deviceInvalidations\":" + std::to_string(diag.deviceInvalidations) + ",";
        result += "\"deviceRestarts\":" + std::to_string(diag.deviceRestarts) + ",";
        result += "\"lastHresult\":" + std::to_string(static_cast<long>(diag.lastHresult)) + ",";
        result += "\"lastError\":\"";
        {
            // Escape quotes in lastError
            std::string escaped = diag.lastError;
            size_t pos = 0;
            while ((pos = escaped.find('"', pos)) != std::string::npos) {
                escaped.replace(pos, 1, "\\\"");
                pos += 2;
            }
            result += escaped;
        }
        result += "\"";
        result += "}";
    } else {
        result = "{";
        result += "\"sourceType\":\"none\"";
        result += "}";
    }

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", ctx.requestId);
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
// StopAudioResources
// ========================================================================

void ServiceSession::StopAudioResources() {
    // Stop filtered monitor first (owns its own captures, mixer, and threads)
    if (filteredMonitor_) {
        filteredMonitor_->Stop();
        filteredMonitor_.reset();
    }

    // Stop application capture source
    if (applicationSource_) {
        applicationSource_->Stop();
        applicationSource_.reset();
    }

    // Stop endpoint loopback source
    if (endpointSource_) {
        endpointSource_->Stop();
        endpointSource_.reset();
    }

    // Clear active source type
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_.clear();
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

    // Copy frame data and compute energy diagnostics
    if (packet.frames && packet.frameCount > 0) {
        size_t sampleCount = static_cast<size_t>(packet.frameCount) *
                             packet.channels;
        pcmPacket.payload.assign(packet.frames,
                                 packet.frames + sampleCount);

        // Energy diagnostics for Application Audio
        appAudioDiag_.packets.fetch_add(1, std::memory_order_relaxed);
        appAudioDiag_.frames.fetch_add(packet.frameCount, std::memory_order_relaxed);

        if (packet.isSilent) {
            appAudioDiag_.silentFlagPackets.fetch_add(1, std::memory_order_relaxed);
        }

        float localPeak = 0.0f;
        uint64_t localNonZeroSamples = 0;

        for (size_t i = 0; i < sampleCount; ++i) {
            float sample = packet.frames[i];
            localPeak = (std::max)(localPeak, std::abs(sample));
            if (sample != 0.0f) {
                ++localNonZeroSamples;
            }
        }

        if (localNonZeroSamples == 0) {
            appAudioDiag_.zeroDataPackets.fetch_add(1, std::memory_order_relaxed);
        } else {
            appAudioDiag_.nonZeroPackets.fetch_add(1, std::memory_order_relaxed);
            appAudioDiag_.nonZeroSamples.fetch_add(localNonZeroSamples, std::memory_order_relaxed);
        }

        // Running peak (atomic max)
        float expected = appAudioDiag_.peak.load(std::memory_order_relaxed);
        while (localPeak > expected &&
               !appAudioDiag_.peak.compare_exchange_weak(expected, localPeak,
                   std::memory_order_relaxed)) {
            expected = appAudioDiag_.peak.load(std::memory_order_relaxed);
        }
    }

    totalPackets_.fetch_add(1, std::memory_order_relaxed);
    totalPayloadBytes_.fetch_add(hdr.payloadBytes, std::memory_order_relaxed);
    capturePacketsProduced_.fetch_add(1, std::memory_order_relaxed);
    captureBytesProduced_.fetch_add(hdr.payloadBytes, std::memory_order_relaxed);
    sourcePacketsEnqueued_.fetch_add(1, std::memory_order_relaxed);

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
