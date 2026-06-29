#include "BuildInfo.h"
#include "Protocol.h"
#include "FrameTransport.h"
#include "Diagnostics.h"
#include "CapabilityProbe.h"
#include "SimpleJson.h"
#include "NvidiaVfxContext.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>
#include <thread>
#include <chrono>
#include <algorithm>
#include <algorithm>
#include <memory>
#include <unordered_map>

// Undef Windows min/max macros
#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

namespace sv = screenlink::video;

// â”€â”€â”€ Processing mode / quality stringâ†’number mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Global configuration (set by --serve commands) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ NVIDIA VFX context (lazy-init on configure) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

static std::unique_ptr<sv::NvidiaVfxContext> g_nvidiaVfx;
static bool g_nvidiaAvailable = false;
static std::string g_nvidiaReason;

static void InitNvidiaVfx(uint32_t outW, uint32_t outH) {
    if (g_nvidiaVfx) return;

    g_nvidiaVfx = std::make_unique<sv::NvidiaVfxContext>();
    sv::NvVfxConfig vfxConfig;
    vfxConfig.modelDir = sv::NvidiaVfxContext::FindModelDir(
        sv::NvidiaVfxContext::FindSdkRoot());
    vfxConfig.strength = std::max(1, std::min(4, static_cast<int32_t>(g_config.qualityLevel) + 1));

    auto result = g_nvidiaVfx->Initialize(vfxConfig);
    if (result == sv::NvVfxResult::kSuccess) {
        result = g_nvidiaVfx->CreateEffect();
    }
    if (result != sv::NvVfxResult::kSuccess) {
        g_nvidiaReason = g_nvidiaVfx->GetLastError();
        g_nvidiaVfx.reset();
        g_nvidiaAvailable = false;
        return;
    }

    // Allocate input/output images matching configured dimensions
    sv::NvVfxImage inputDesc;
    inputDesc.width = g_config.inputWidth;
    inputDesc.height = g_config.inputHeight;
    inputDesc.stride = g_config.inputWidth * 4;
    inputDesc.format = sv::NvVfxPixelFormat::kRGBA8;
    inputDesc.pixels = nullptr;

    sv::NvVfxImage outputDesc;
    outputDesc.width = outW;
    outputDesc.height = outH;
    outputDesc.stride = outW * 4;
    outputDesc.format = sv::NvVfxPixelFormat::kRGBA8;
    outputDesc.pixels = nullptr;

    if (g_nvidiaVfx->AllocateInput(inputDesc) != sv::NvVfxResult::kSuccess ||
        g_nvidiaVfx->AllocateOutput(outputDesc) != sv::NvVfxResult::kSuccess) {
        g_nvidiaReason = "Failed to allocate NVIDIA image resources";
        g_nvidiaVfx.reset();
        g_nvidiaAvailable = false;
        return;
    }

    g_nvidiaAvailable = true;
    printf("[Serve] NVIDIA Super Resolution initialized: %ux%u -> %ux%u\n",
           g_config.inputWidth, g_config.inputHeight, outW, outH);
}

static void ShutdownNvidiaVfx() {
    if (g_nvidiaVfx) {
        g_nvidiaVfx->Destroy();
        g_nvidiaVfx.reset();
    }
    g_nvidiaAvailable = false;
}

// â”€â”€â”€ Helper: create JSON response â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

static sv::JsonObject MakeResponse(bool success, const std::string& errorMsg = "", const std::string& id = "") {
    sv::JsonObject resp;
    if (!id.empty()) resp["id"] = sv::JsonValue(id);
    resp["success"] = sv::JsonValue(success);
    if (!errorMsg.empty()) {
        resp["error"] = sv::JsonValue(errorMsg);
    }
    return resp;
}

// â”€â”€â”€ Command handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    // Initialize NVIDIA VFX on configure
    ShutdownNvidiaVfx();
    InitNvidiaVfx(g_config.outputWidth, g_config.outputHeight);

    printf("[Serve] Configured: %ux%u -> %ux%u mode=%u quality=%u pf=%s NVIDIA=%s\n",
           g_config.inputWidth, g_config.inputHeight,
           g_config.outputWidth, g_config.outputHeight,
           g_config.processingMode, g_config.qualityLevel,
           g_config.pixelFormat.c_str(),
           g_nvidiaAvailable ? "active" : g_nvidiaReason.c_str());
    return true;
}

static sv::DiagnosticSnapshot BuildStatsResponse() {
    return sv::GetDiagnostics();
}

// â”€â”€â”€ Capabilities command â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Serve mode main loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    printf("[Serve] Pipes created, waiting for control client...\n");

    // Accept control connection first (audit item 11)
    // This avoids a deadlock where native waits for frame pipe while
    // Electron waits for the control handshake response.
    if (!transport.WaitForClient(transport.GetControlPipe())) {
        fprintf(stderr, "[Serve] Control pipe client never connected\n");
        transport.CloseControlPipe();
        transport.CloseFramePipe();
        return static_cast<int>(sv::ExitCode::kServeFailed);
    }
    printf("[Serve] Control client connected\n");

    // Perform hello handshake on the control pipe
    {
        auto helloMsg = transport.ReadControlMessage();
        if (helloMsg.empty()) {
            fprintf(stderr, "[Serve] No hello message from control client\n");
            transport.CloseControlPipe();
            transport.CloseFramePipe();
            return static_cast<int>(sv::ExitCode::kServeFailed);
        }
        sv::JsonObject helloReq;
        try { helloReq = sv::ParseJson(helloMsg); }
        catch (const std::exception& e) {
            fprintf(stderr, "[Serve] Hello JSON parse error: %s\n", e.what());
            return static_cast<int>(sv::ExitCode::kServeFailed);
        }
        bool helloOk = HandleHello(helloReq);
        transport.WriteControlResponse(
            sv::SerializeJson(MakeResponse(helloOk, helloOk ? "hello OK" : "auth failed")));
        if (!helloOk) {
            fprintf(stderr, "[Serve] Hello authentication failed\n");
            transport.CloseControlPipe();
            transport.CloseFramePipe();
            return static_cast<int>(sv::ExitCode::kServeFailed);
        }
    }

    // Now accept persistent frame pipe (after handshake, Electron knows we're alive)
    printf("[Serve] Waiting for persistent frame pipe client...\n");
    if (!transport.WaitForClient(transport.GetFramePipe())) {
        fprintf(stderr, "[Serve] Frame pipe client never connected\n");
        transport.CloseControlPipe();
        transport.CloseFramePipe();
        return static_cast<int>(sv::ExitCode::kServeFailed);
    }
    printf("[Serve] Frame pipe client connected\n");

    // Start frame-processing worker thread (audit item 12)
    // Continuously reads frames from the persistent frame pipe,
    // processes them, and writes results back.
    std::thread frameWorker([&transport]() {
        while (true) {
            sv::FrameHeader header;
            std::vector<uint8_t> frameData;

            if (!transport.ReadFrame(header, frameData)) {
                // Pipe closed or error â€” exit worker
                fprintf(stderr, "[FrameWorker] Frame pipe read failed, stopping\n");
                break;
            }

            if (!g_config.configured) {
                // Configuration required first â€” skip
                continue;
            }

            // Validate dimensions match configured size
            if (header.inputWidth != g_config.inputWidth ||
                header.inputHeight != g_config.inputHeight) {
                fprintf(stderr,
                    "[FrameWorker] Frame size mismatch: %ux%u vs configured %ux%u\n",
                    header.inputWidth, header.inputHeight,
                    g_config.inputWidth, g_config.inputHeight);
                // Still process with actual dimensions
            }

            auto& diag = sv::GetDiagnosticsCounters();
            diag.totalFramesSubmitted++;

            // Process the frame
            auto start = std::chrono::high_resolution_clock::now();
            bool ok = false;
            sv::FrameHeader outHeader = header;
            std::vector<uint8_t> outData;

            if (g_nvidiaAvailable && g_nvidiaVfx) {
                // Upload input pixels to NVIDIA
                ok = g_nvidiaVfx->UploadInput(
                    frameData.data(),
                    header.inputWidth, header.inputHeight,
                    header.inputStride,
                    sv::NvVfxPixelFormat::kRGBA8
                ) == sv::NvVfxResult::kSuccess;

                if (ok) {
                    ok = g_nvidiaVfx->RunFrame() == sv::NvVfxResult::kSuccess;
                }

                if (ok) {
                    // Download output
                    uint32_t outW = 0, outH = 0;
                    outHeader.payloadBytes = g_config.outputWidth * g_config.outputHeight * 4;
                    outData.resize(outHeader.payloadBytes);
                    ok = g_nvidiaVfx->DownloadOutput(
                        outData.data(), g_config.outputWidth * 4, outW, outH
                    ) == sv::NvVfxResult::kSuccess;
                    if (ok) {
                        outHeader.inputWidth = outW;
                        outHeader.inputHeight = outH;
                        outHeader.inputStride = outW * 4;
                    }
                }

                if (!ok) {
                    fprintf(stderr, "[FrameWorker] NVIDIA VFX failed: %s\n",
                            g_nvidiaVfx->GetLastError().c_str());
                }
            } else {
                // Passthrough: copy input to output
                outHeader.inputWidth = header.inputWidth;
                outHeader.inputHeight = header.inputHeight;
                outHeader.inputStride = header.inputWidth * 4;
                outHeader.payloadBytes = static_cast<uint32_t>(frameData.size());
                outData = frameData;
                ok = true;
            }

            auto end = std::chrono::high_resolution_clock::now();
            auto us = std::chrono::duration_cast<std::chrono::microseconds>(end - start).count();
            diag.RecordFrame(static_cast<uint64_t>(us), ok);

            if (ok) {
                // Write back the processed frame
                if (!transport.WriteFrame(outHeader, outData.data(), outData.size())) {
                    fprintf(stderr, "[FrameWorker] Failed to write output frame\n");
                }
            } else {
                fprintf(stderr, "[FrameWorker] Frame processing failed\n");
            }
        }
    });

    // Control loop: process commands on the control pipe
    while (true) {
        auto msg = transport.ReadControlMessage();
        if (msg.empty()) {
            printf("[Serve] Control client disconnected\n");
            break;
        }

        // Parse and handle control commands
        sv::JsonObject req;
        try { req = sv::ParseJson(msg); }
        catch (const std::exception& e) {
            fprintf(stderr, "[Serve] JSON parse error: %s\n", e.what());
            transport.WriteControlResponse(sv::SerializeJson(MakeResponse(false, "JSON parse error")));
            continue;
        }

        auto cmdStr = sv::GetString(req, "command");
        if (!cmdStr.has_value()) {
            transport.WriteControlResponse(sv::SerializeJson(MakeResponse(false, "Missing 'command'")));
            continue;
        }

        auto cmd = sv::ParseCommand(*cmdStr);
        sv::JsonObject payload;
        auto it = req.find("payload");
        if (it != req.end()) {
            if (std::holds_alternative<std::shared_ptr<sv::JsonObject>>(it->second)) {
                payload = *std::get<std::shared_ptr<sv::JsonObject>>(it->second);
            }
        }
        auto reqId = sv::GetString(req, "id");
        std::string id = reqId.has_value() ? *reqId : "";

        sv::JsonObject response;
        bool success = false;

        switch (cmd) {
            case sv::Command::kConfigure:
                success = HandleConfigure(payload);
                response = MakeResponse(success, success ? "" : "Configuration failed", id);
                break;

            case sv::Command::kCapabilities:
                HandleCapabilities(payload, transport, id);
                continue;

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
                // Disconnect pipes to wake the frame worker
                transport.CloseFramePipe();
                transport.CloseControlPipe();
                ShutdownNvidiaVfx();
                if (frameWorker.joinable()) frameWorker.join();
                return 0;

            default:
                response = MakeResponse(false, "Unknown command: " + *cmdStr, id);
                break;
        }

        transport.WriteControlResponse(sv::SerializeJson(response));
    }

    // Cleanup control pipe and join frame worker
    transport.CloseFramePipe();
    transport.CloseControlPipe();
    ShutdownNvidiaVfx();
    if (frameWorker.joinable()) frameWorker.join();

    return 0;
}

// â”€â”€â”€ CLI subcommands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    auto cap = sv::ProbeCapability();

#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
    allPassed &= cap.available;
    allPassed &= (cap.reason == "available");
#else
    allPassed &= !cap.available;
    allPassed &= (cap.reason == "sdk-not-built");
#endif

    // Stringâ†’number mapping
    allPassed &= (MapProcessingMode("vsr") == 1);
    allPassed &= (MapProcessingMode("high-bitrate") == 2);
    allPassed &= (MapQualityLevel("high") == 2);
    allPassed &= (MapQualityLevel("ultra") == 3);

    printf("Self-tests: %s\n", allPassed ? "ALL PASSED" : "FAILED");
    return allPassed ? 0 : 1;
}

// â”€â”€â”€ Entry point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

static int RunVfxFrameTest() {
#ifndef SCREENLINK_NVIDIA_VFX_ENABLED
    fprintf(stderr, "VFX frame test unavailable: sdk-not-built\n");
    return 2;
#else
    constexpr uint32_t inputWidth = 320;
    constexpr uint32_t inputHeight = 180;
    constexpr uint32_t outputWidth = 640;
    constexpr uint32_t outputHeight = 360;
    constexpr uint32_t inputStride = inputWidth * 4;
    constexpr uint32_t outputStride = outputWidth * 4;

    std::vector<uint8_t> input(
        static_cast<size_t>(inputStride) * inputHeight);

    // High-frequency checkerboard plus gradients, so the output cannot
    // legitimately be uniformly zero or a single constant value.
    for (uint32_t y = 0; y < inputHeight; ++y) {
        for (uint32_t x = 0; x < inputWidth; ++x) {
            const size_t offset =
                static_cast<size_t>(y) * inputStride +
                static_cast<size_t>(x) * 4;

            const bool checker = ((x / 8) + (y / 8)) % 2 == 0;

            input[offset + 0] = checker
                ? static_cast<uint8_t>((x * 255) / (inputWidth - 1))
                : static_cast<uint8_t>(255 - ((x * 255) / (inputWidth - 1)));

            input[offset + 1] =
                static_cast<uint8_t>((y * 255) / (inputHeight - 1));

            input[offset + 2] = checker ? 240 : 16;
            input[offset + 3] = 255;
        }
    }

    for (int quality = 0; quality <= 4; ++quality) {
        sv::NvidiaVfxContext context;
        sv::NvVfxConfig config;
        config.strength = quality;

        auto fail = [&](const char* stage) {
            fprintf(
                stderr,
                "VFX frame test failed at %s for QualityLevel=%d: %s\n",
                stage,
                quality,
                context.GetLastError().c_str());
            return 1;
        };

        if (context.Initialize(config) != sv::NvVfxResult::kSuccess) {
            return fail("Initialize");
        }

        if (context.CreateEffect() != sv::NvVfxResult::kSuccess) {
            return fail("CreateEffect");
        }

        sv::NvVfxImage inputDesc;
        inputDesc.width = inputWidth;
        inputDesc.height = inputHeight;
        inputDesc.stride = inputStride;
        inputDesc.format = sv::NvVfxPixelFormat::kRGBA8;

        if (context.AllocateInput(inputDesc) != sv::NvVfxResult::kSuccess) {
            return fail("AllocateInput");
        }

        sv::NvVfxImage outputDesc;
        outputDesc.width = outputWidth;
        outputDesc.height = outputHeight;
        outputDesc.stride = outputStride;
        outputDesc.format = sv::NvVfxPixelFormat::kRGBA8;

        if (context.AllocateOutput(outputDesc) != sv::NvVfxResult::kSuccess) {
            return fail("AllocateOutput/NvVFX_Load");
        }

        if (context.UploadInput(
                input.data(),
                inputWidth,
                inputHeight,
                inputStride,
                sv::NvVfxPixelFormat::kRGBA8) !=
            sv::NvVfxResult::kSuccess) {
            return fail("UploadInput");
        }

        if (context.RunFrame() != sv::NvVfxResult::kSuccess) {
            return fail("RunFrame");
        }

        std::vector<uint8_t> output(
            static_cast<size_t>(outputStride) * outputHeight);

        uint32_t actualWidth = 0;
        uint32_t actualHeight = 0;

        if (context.DownloadOutput(
                output.data(),
                outputStride,
                actualWidth,
                actualHeight) != sv::NvVfxResult::kSuccess) {
            return fail("DownloadOutput");
        }

        if (actualWidth != outputWidth || actualHeight != outputHeight) {
            fprintf(
                stderr,
                "VFX frame test returned incorrect dimensions for "
                "QualityLevel=%d: %ux%u, expected %ux%u\n",
                quality,
                actualWidth,
                actualHeight,
                outputWidth,
                outputHeight);
            return 1;
        }

        uint64_t checksum = 1469598103934665603ull;
        uint8_t minimumValue = 255;
        uint8_t maximumValue = 0;
        bool anyNonZero = false;

        for (uint8_t value : output) {
            checksum ^= value;
            checksum *= 1099511628211ull;

            minimumValue = std::min(minimumValue, value);
            maximumValue = std::max(maximumValue, value);
            anyNonZero = anyNonZero || value != 0;
        }

        if (!anyNonZero || minimumValue == maximumValue) {
            fprintf(
                stderr,
                "VFX frame test produced empty or uniform output for "
                "QualityLevel=%d\n",
                quality);
            return 1;
        }

        printf(
            "QualityLevel=%d PASS: %ux%u -> %ux%u, "
            "checksum=%llu, range=%u..%u\n",
            quality,
            inputWidth,
            inputHeight,
            actualWidth,
            actualHeight,
            static_cast<unsigned long long>(checksum),
            static_cast<unsigned int>(minimumValue),
            static_cast<unsigned int>(maximumValue));
    }

    printf("VFX frame tests: ALL PASSED\n");
    return 0;
#endif
}
int main(int argc, char* argv[]) {
    std::vector<std::string> args;
    for (int i = 1; i < argc; ++i) args.push_back(argv[i]);

    if (args.empty()) {
        PrintVersion();
        return 0;
    }

    if (args[0] == "--version") { PrintVersion(); return 0; }
    if (args[0] == "--capabilities") { return RunCapabilities(); }
    if (args[0] == "--vfx-frame-test") { return RunVfxFrameTest(); }
    if (args[0] == "--self-test") { return RunSelfTest(); }
    if (args[0] == "--serve") { return RunServe(args); }

    fprintf(stderr, "Unknown command: %s\n", args[0].c_str());
    return static_cast<int>(sv::ExitCode::kUnknownCommand);
}
