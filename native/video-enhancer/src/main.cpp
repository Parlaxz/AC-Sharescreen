#include "BuildInfo.h"
#include "Protocol.h"
#include "FrameTransport.h"
#include "Diagnostics.h"
#include "CapabilityProbe.h"
#include "SimpleJson.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>
#include <thread>
#include <chrono>
#include <algorithm>
#include <unordered_map>

namespace sv = screenlink::video;

// ─── Processing mode / quality string→number mapping ──────────────────

static uint32_t MapProcessingMode(const std::string& s) {
    static const std::unordered_map<std::string, uint32_t> map = {
        {"vsr", 1},
        {"high-bitrate", 2},
        {"denoise", 3},
        {"deblur", 4},
    };
    auto it = map.find(s);
    return it != map.end() ? it->second : 1;
}

static uint32_t MapQualityLevel(const std::string& s) {
    static const std::unordered_map<std::string, uint32_t> map = {
        {"low", 0},
        {"medium", 1},
        {"high", 2},
        {"ultra", 3},
    };
    auto it = map.find(s);
    return it != map.end() ? it->second : 2;
}

// ─── Global configuration (set by --serve commands) ───────────────────

static struct {
    std::string sessionId;
    std::string authToken;
    uint32_t inputWidth = 1920;
    uint32_t inputHeight = 1080;
    uint32_t outputWidth = 1920;
    uint32_t outputHeight = 1080;
    uint32_t processingMode = 1;
    uint32_t qualityLevel = 2;
    std::string pixelFormat;
    bool configured = false;
} g_config;

// ─── Helper: create JSON response ─────────────────────────────────────

static sv::JsonObject MakeResponse(bool success, const std::string& errorMsg = "", const std::string& id = "") {
    sv::JsonObject resp;
    if (!id.empty()) resp["id"] = sv::JsonValue(id);
    resp["success"] = sv::JsonValue(success);
    if (!errorMsg.empty()) {
        resp["error"] = sv::JsonValue(errorMsg);
    }
    return resp;
}

// ─── Command handlers ─────────────────────────────────────────────────

static bool HandleHello(const sv::JsonObject& req) {
    auto proto = sv::GetString(req, "protocolVersion");
    auto sid = sv::GetString(req, "sessionId");
    auto token = sv::GetString(req, "authToken");

    if (!proto.has_value() || !sid.has_value() || !token.has_value()) {
        fprintf(stderr, "[Serve] hello: missing required fields\n");
        return false;
    }

    if (*sid != g_config.sessionId || *token != g_config.authToken) {
        fprintf(stderr, "[Serve] hello: auth mismatch (sid=%s)\n", sid->c_str());
        return false;
    }

    printf("[Serve] Client hello OK (protocol=%s)\n", proto->c_str());
    return true;
}

static bool HandleConfigure(const sv::JsonObject& payload) {
    const auto& obj = payload;

    g_config.inputWidth = static_cast<uint32_t>(
        sv::GetNumber(obj, "inputWidth", 1920));
    g_config.inputHeight = static_cast<uint32_t>(
        sv::GetNumber(obj, "inputHeight", 1080));
    g_config.outputWidth = static_cast<uint32_t>(
        sv::GetNumber(obj, "outputWidth", 1920));
    g_config.outputHeight = static_cast<uint32_t>(
        sv::GetNumber(obj, "outputHeight", 1080));

    // Accept both string and number for processingMode / qualityLevel
    auto modeStr = sv::GetString(obj, "processingMode");
    if (modeStr) {
        g_config.processingMode = MapProcessingMode(*modeStr);
    } else {
        g_config.processingMode = static_cast<uint32_t>(
            sv::GetNumber(obj, "processingMode", 1));
    }

    auto qualStr = sv::GetString(obj, "qualityLevel");
    if (qualStr) {
        g_config.qualityLevel = MapQualityLevel(*qualStr);
    } else {
        g_config.qualityLevel = static_cast<uint32_t>(
            sv::GetNumber(obj, "qualityLevel", 2));
    }

    auto pf = sv::GetString(obj, "pixelFormat");
    if (pf) g_config.pixelFormat = *pf;

    g_config.configured = true;

    printf("[Serve] Configured: %ux%u -> %ux%u mode=%u quality=%u pf=%s\n",
           g_config.inputWidth, g_config.inputHeight,
           g_config.outputWidth, g_config.outputHeight,
           g_config.processingMode, g_config.qualityLevel,
           g_config.pixelFormat.c_str());
    return true;
}

static bool HandleSubmitFrame(const sv::JsonObject& /*payload*/,
                               sv::FrameTransport& transport) {
    if (!g_config.configured) {
        fprintf(stderr, "[Serve] submit-frame: not configured\n");
        return false;
    }

    sv::FrameHeader header;
    std::vector<uint8_t> frameData;

    if (!transport.ReadFrame(header, frameData)) {
        fprintf(stderr, "[Serve] submit-frame: read failed\n");
        return false;
    }

    // Validate frame dimensions
    if (header.payloadBytes > sv::kMaxFrameSize) {
        fprintf(stderr, "[Serve] submit-frame: frame too large (%u > %u)\n",
                header.payloadBytes, sv::kMaxFrameSize);
        return false;
    }

    // Record receipt
    auto start = std::chrono::steady_clock::now();

    // Processing: non-VFX build returns the input frame unchanged (passthrough).
    // The real VFX build (SCREENLINK_NVIDIA_VFX_ENABLED) will invoke the
    // NVIDIA Video Effects SDK in Phase Q.
    std::vector<uint8_t> outputData(frameData);

    auto end = std::chrono::steady_clock::now();
    uint64_t elapsedUs = std::chrono::duration_cast<std::chrono::microseconds>(end - start).count();

    sv::GetDiagnosticsCounters().RecordFrame(elapsedUs, true);

    // Write result back
    sv::FrameHeader resultHeader = header;
    resultHeader.resultCode = 1; // success
    resultHeader.payloadBytes = static_cast<uint32_t>(outputData.size());
    resultHeader.requestedOutputWidth = header.inputWidth;
    resultHeader.requestedOutputHeight = header.inputHeight;

    if (!transport.WriteFrame(resultHeader, outputData.data(), outputData.size())) {
        fprintf(stderr, "[Serve] submit-frame: write result failed\n");
        return false;
    }

    printf("[Serve] Frame %u processed (passthrough): %ux%u %u bytes in %lluus\n",
           header.frameSequence,
           header.inputWidth, header.inputHeight,
           header.payloadBytes,
           static_cast<unsigned long long>(elapsedUs));
    return true;
}

static sv::DiagnosticSnapshot BuildStatsResponse() {
    return sv::GetDiagnostics();
}

// ─── Capabilities command ─────────────────────────────────────────────

static void HandleCapabilities(const sv::JsonObject& /*payload*/,
                                sv::FrameTransport& transport,
                                const std::string& id) {
    auto result = sv::ProbeCapability();
    sv::JsonObject resp;
    if (!id.empty()) resp["id"] = sv::JsonValue(id);
    resp["success"] = sv::JsonValue(true);
    resp["available"] = sv::JsonValue(result.available);
    resp["reason"] = sv::JsonValue(result.reason);
    resp["adapterName"] = sv::JsonValue(result.adapterName);
    resp["driverVersion"] = sv::JsonValue(result.driverVersion);
    if (!result.supportedModes.empty())
        resp["supportedModes"] = sv::JsonValue(result.supportedModes);
    if (!result.supportedQualities.empty())
        resp["supportedQualities"] = sv::JsonValue(result.supportedQualities);
    transport.WriteControlResponse(sv::SerializeJson(resp));
}

// ─── Serve mode main loop ─────────────────────────────────────────────

static int RunServe(const std::vector<std::string>& args) {
    std::string ctrlPipe, framePipe, sessionId, authToken;
    uint32_t parentPid = 0;

    for (size_t i = 0; i < args.size(); ++i) {
        if (args[i] == "--control-pipe" && i + 1 < args.size())
            ctrlPipe = args[++i];
        else if (args[i] == "--frame-pipe" && i + 1 < args.size())
            framePipe = args[++i];
        else if (args[i] == "--session-id" && i + 1 < args.size())
            sessionId = args[++i];
        else if (args[i] == "--auth-token" && i + 1 < args.size())
            authToken = args[++i];
        else if (args[i] == "--parent-pid" && i + 1 < args.size())
            parentPid = static_cast<uint32_t>(std::stoul(args[++i]));
    }

    if (ctrlPipe.empty() || framePipe.empty() || sessionId.empty() || authToken.empty()) {
        fprintf(stderr, "Missing required arguments for --serve\n");
        return static_cast<int>(sv::ExitCode::kServeFailed);
    }

    g_config.sessionId = sessionId;
    g_config.authToken = authToken;

    printf("Video-enhancer serve mode started\n");
    printf("  Control pipe: %s\n", ctrlPipe.c_str());
    printf("  Frame pipe: %s\n", framePipe.c_str());
    printf("  Session: %s\n", sessionId.c_str());
    if (parentPid) {
        printf("  Parent PID: %u\n", parentPid);
    }

    sv::FrameTransport transport;

    if (!transport.CreateControlPipe(ctrlPipe)) {
        fprintf(stderr, "[Serve] Failed to create control pipe\n");
        return static_cast<int>(sv::ExitCode::kServeFailed);
    }
    if (!transport.CreateFramePipe(framePipe)) {
        fprintf(stderr, "[Serve] Failed to create frame pipe\n");
        transport.CloseControlPipe();
        return static_cast<int>(sv::ExitCode::kServeFailed);
    }

    printf("[Serve] Pipes created, waiting for client...\n");

    while (true) {
        if (!transport.WaitForClient(transport.GetControlPipe())) {
            fprintf(stderr, "[Serve] Control pipe connection failed, retrying...\n");
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            continue;
        }

        printf("[Serve] Control client connected\n");

        bool clientDone = false;
        while (!clientDone) {
            auto msg = transport.ReadControlMessage();
            if (msg.empty()) {
                printf("[Serve] Control client disconnected\n");
                break;
            }

            // Parse JSON
            sv::JsonObject req;
            try {
                req = sv::ParseJson(msg);
            } catch (const std::exception& e) {
                fprintf(stderr, "[Serve] JSON parse error: %s\n", e.what());
                transport.WriteControlResponse(
                    sv::SerializeJson(MakeResponse(false, "JSON parse error")));
                continue;
            }

            auto cmdStr = sv::GetString(req, "command");
            if (!cmdStr.has_value()) {
                transport.WriteControlResponse(
                    sv::SerializeJson(MakeResponse(false, "Missing 'command' field")));
                continue;
            }

            auto cmd = sv::ParseCommand(*cmdStr);

            // Extract payload from the nested "payload" field
            sv::JsonObject payload;
            auto it = req.find("payload");
            if (it != req.end()) {
                if (std::holds_alternative<std::shared_ptr<sv::JsonObject>>(it->second)) {
                    payload = *std::get<std::shared_ptr<sv::JsonObject>>(it->second);
                }
            }

            // Extract request ID for correlation
            auto reqId = sv::GetString(req, "id");
            std::string id = reqId.has_value() ? *reqId : "";

            sv::JsonObject response;
            bool success = false;

            switch (cmd) {
                case sv::Command::kHello:
                    success = HandleHello(req);
                    response = MakeResponse(success, success ? "" : "Authentication failed", id);
                    break;

                case sv::Command::kCapabilities:
                    HandleCapabilities(payload, transport, id);
                    continue;

                case sv::Command::kConfigure:
                    success = HandleConfigure(payload);
                    response = MakeResponse(success, success ? "" : "Configuration failed", id);
                    break;

                case sv::Command::kFrameAvailable: {
                    if (!transport.WaitForClient(transport.GetFramePipe())) {
                        response = MakeResponse(false, "Frame pipe connection failed", id);
                    } else {
                        success = HandleSubmitFrame(payload, transport);
                        response = MakeResponse(success, success ? "" : "Frame processing failed", id);
                        DisconnectNamedPipe(transport.GetFramePipe());
                    }
                    break;
                }

                case sv::Command::kFlush:
                    response = MakeResponse(true, "", id);
                    break;

                case sv::Command::kStats: {
                    auto stats = BuildStatsResponse();
                    sv::JsonObject resp;
                    resp["id"] = sv::JsonValue(id);
                    resp["success"] = sv::JsonValue(true);
                    resp["totalFramesSubmitted"] = sv::JsonValue(static_cast<double>(stats.totalFramesSubmitted));
                    resp["totalFramesCompleted"] = sv::JsonValue(static_cast<double>(stats.totalFramesCompleted));
                    resp["totalFramesDropped"] = sv::JsonValue(static_cast<double>(stats.totalFramesDropped));
                    resp["totalProcessingErrors"] = sv::JsonValue(static_cast<double>(stats.totalProcessingErrors));
                    resp["totalBytesProcessed"] = sv::JsonValue(static_cast<double>(stats.totalBytesProcessed));
                    resp["lastProcessingTimeUs"] = sv::JsonValue(static_cast<double>(stats.lastProcessingTimeUs));
                    resp["maxProcessingTimeUs"] = sv::JsonValue(static_cast<double>(stats.maxProcessingTimeUs));
                    resp["minProcessingTimeUs"] = sv::JsonValue(static_cast<double>(stats.minProcessingTimeUs));
                    response = resp;
                    break;
                }

                case sv::Command::kShutdown:
                    printf("[Serve] Shutdown requested\n");
                    transport.WriteControlResponse(sv::SerializeJson(MakeResponse(true, "", id)));
                    transport.CloseControlPipe();
                    transport.CloseFramePipe();
                    return 0;

                default:
                    fprintf(stderr, "[Serve] Unknown command: %s\n", cmdStr->c_str());
                    response = MakeResponse(false, "Unknown command", id);
                    break;
            }

            transport.WriteControlResponse(sv::SerializeJson(response));
        }

        DisconnectNamedPipe(transport.GetControlPipe());
        printf("[Serve] Waiting for next client...\n");
    }

    return 0;
}

// ─── CLI subcommands ──────────────────────────────────────────────────

static void PrintVersion() {
    printf("{\n");
    printf("  \"name\": \"screenlink-video-enhancer\",\n");
    printf("  \"version\": \"0.1.0\",\n");
    printf("  \"protocolVersion\": \"%s\",\n", sv::kProtocolVersion.data());
    printf("  \"build\": {\n");
    printf("    \"commit\": \"%s\",\n", sv::build::kGitCommit.data());
    printf("    \"dirty\": %s,\n", sv::build::kGitDirty.data());
    printf("    \"branch\": \"%s\",\n", sv::build::kGitBranch.data());
    printf("    \"timestamp\": \"%s\",\n", sv::build::kBuildTimestamp.data());
    printf("    \"configuration\": \"%s\",\n", sv::build::kBuildConfig.data());
    printf("    \"compiler\": \"%s\"\n", sv::build::kCompilerId.data());
    printf("  }\n");
    printf("}\n");
}

static int RunCapabilities() {
    auto result = sv::ProbeCapability();
    printf("{\n");
    printf("  \"available\": %s,\n", result.available ? "true" : "false");
    printf("  \"reason\": \"%s\",\n", result.reason.c_str());
    if (!result.adapterName.empty())
        printf("  \"adapterName\": \"%s\",\n", result.adapterName.c_str());
    if (!result.driverVersion.empty())
        printf("  \"driverVersion\": \"%s\",\n", result.driverVersion.c_str());
    if (!result.supportedModes.empty())
        printf("  \"supportedModes\": \"%s\",\n", result.supportedModes.c_str());
    if (!result.supportedQualities.empty())
        printf("  \"supportedQualities\": \"%s\",\n", result.supportedQualities.c_str());
    printf("  \"success\": true\n");
    printf("}\n");
    return result.available ? 0 : 1;
}

static int RunSelfTest() {
    bool allPassed = true;

    // Command parsing
    auto cmd = sv::ParseCommand("hello");
    allPassed &= (cmd == sv::Command::kHello);
    cmd = sv::ParseCommand("unknown_command");
    allPassed &= (cmd == sv::Command::kUnknown);
    cmd = sv::ParseCommand("shutdown");
    allPassed &= (cmd == sv::Command::kShutdown);

    auto name = sv::CommandName(sv::Command::kCapabilities);
    allPassed &= (name == "capabilities");
    name = sv::CommandName(sv::Command::kUnknown);
    allPassed &= (name == "unknown");

    allPassed &= !sv::kProtocolVersion.empty();

    // JSON parser
    try {
        auto obj = sv::ParseJson(R"({"hello":"world","num":42,"flag":true})");
        allPassed &= (sv::GetString(obj, "hello").has_value());
        allPassed &= (*sv::GetString(obj, "hello") == "world");
        allPassed &= (sv::GetNumber(obj, "num") == 42.0);
        allPassed &= (sv::GetBool(obj, "flag") == true);
    } catch (...) {
        allPassed = false;
    }

    // JSON round-trip
    try {
        sv::JsonObject obj;
        obj["test"] = sv::JsonValue(std::string("value"));
        obj["num"] = sv::JsonValue(123.0);
        auto json = sv::SerializeJson(obj);
        auto parsed = sv::ParseJson(json);
        auto val = sv::GetString(parsed, "test");
        allPassed &= (val.has_value() && *val == "value");
        allPassed &= (sv::GetNumber(parsed, "num") == 123.0);
    } catch (...) {
        allPassed = false;
    }

    // Capability probe (non-VFX build always returns sdk-not-built)
    auto cap = sv::ProbeCapability();
    allPassed &= (!cap.available);
    allPassed &= (!cap.reason.empty());

    // String→number mapping
    allPassed &= (MapProcessingMode("vsr") == 1);
    allPassed &= (MapProcessingMode("high-bitrate") == 2);
    allPassed &= (MapQualityLevel("high") == 2);
    allPassed &= (MapQualityLevel("ultra") == 3);

    printf("Self-tests: %s\n", allPassed ? "ALL PASSED" : "FAILED");
    return allPassed ? 0 : 1;
}

// ─── Entry point ──────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
    std::vector<std::string> args;
    for (int i = 1; i < argc; ++i) args.push_back(argv[i]);

    if (args.empty()) {
        PrintVersion();
        return 0;
    }

    if (args[0] == "--version") { PrintVersion(); return 0; }
    if (args[0] == "--capabilities") { return RunCapabilities(); }
    if (args[0] == "--self-test") { return RunSelfTest(); }
    if (args[0] == "--serve") { return RunServe(args); }

    fprintf(stderr, "Unknown command: %s\n", args[0].c_str());
    return static_cast<int>(sv::ExitCode::kUnknownCommand);
}
