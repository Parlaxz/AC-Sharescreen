#include "BuildInfo.h"
#include "Protocol.h"
#include "FrameTransport.h"
#include "Diagnostics.h"
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

namespace sv = screenlink::video;

// ─── CPU-staging bilinear upscale context ─────────────────────────────

/// Simple CPU-based bilinear upscaler (Phase 7 staging).
/// Replace with GPU-accelerated processing in Phase 7+.
class ProcessingContext {
public:
    ProcessingContext() = default;
    ~ProcessingContext() = default;
    ProcessingContext(const ProcessingContext&) = delete;
    ProcessingContext& operator=(const ProcessingContext&) = delete;

    bool Initialize(uint32_t inputW, uint32_t inputH,
                    uint32_t outputW, uint32_t outputH) {
        inputWidth_ = inputW;
        inputHeight_ = inputH;
        outputWidth_ = outputW;
        outputHeight_ = outputH;
        initialized_ = true;
        printf("[ProcessingContext] Initialized (CPU staging): %ux%u -> %ux%u\n",
               inputW, inputH, outputW, outputH);
        return true;
    }

    void Shutdown() {
        if (initialized_) {
            printf("[ProcessingContext] Shutdown\n");
        }
        initialized_ = false;
    }

    bool ProcessFrame(const void* inputData, uint32_t inputSize,
                      void* outputData, uint32_t outputSize) {
        if (!initialized_) return false;

        uint32_t expectedInput = inputWidth_ * inputHeight_ * 4;
        uint32_t expectedOutput = outputWidth_ * outputHeight_ * 4;

        if (inputSize < expectedInput || outputSize < expectedOutput) {
            fprintf(stderr, "[ProcessingContext] Buffer size mismatch: "
                    "input %u/%u, output %u/%u\n",
                    inputSize, expectedInput, outputSize, expectedOutput);
            return false;
        }

        BilinearUpscale(
            static_cast<const uint8_t*>(inputData), inputWidth_, inputHeight_,
            static_cast<uint8_t*>(outputData), outputWidth_, outputHeight_);
        return true;
    }

    bool IsInitialized() const { return initialized_; }

private:
    static uint8_t Lerp(uint8_t a, uint8_t b, float t) {
        return static_cast<uint8_t>(
            static_cast<float>(a) + (static_cast<float>(b) - static_cast<float>(a)) * t);
    }

    static void BilinearUpscale(const uint8_t* src, uint32_t srcW, uint32_t srcH,
                                uint8_t* dst, uint32_t dstW, uint32_t dstH) {
        for (uint32_t dy = 0; dy < dstH; ++dy) {
            float srcYf = (static_cast<float>(dy) + 0.5f) * static_cast<float>(srcH)
                          / static_cast<float>(dstH) - 0.5f;
            if (srcYf < 0.0f) srcYf = 0.0f;
            if (srcYf > static_cast<float>(srcH) - 1.001f)
                srcYf = static_cast<float>(srcH) - 1.001f;

            uint32_t srcY0 = static_cast<uint32_t>(srcYf);
            uint32_t srcY1 = std::min(srcY0 + 1, srcH - 1);
            float ty = srcYf - static_cast<float>(srcY0);

            for (uint32_t dx = 0; dx < dstW; ++dx) {
                float srcXf = (static_cast<float>(dx) + 0.5f) * static_cast<float>(srcW)
                              / static_cast<float>(dstW) - 0.5f;
                if (srcXf < 0.0f) srcXf = 0.0f;
                if (srcXf > static_cast<float>(srcW) - 1.001f)
                    srcXf = static_cast<float>(srcW) - 1.001f;

                uint32_t srcX0 = static_cast<uint32_t>(srcXf);
                uint32_t srcX1 = std::min(srcX0 + 1, srcW - 1);
                float tx = srcXf - static_cast<float>(srcX0);

                const uint8_t* p00 = src + (srcY0 * srcW + srcX0) * 4;
                const uint8_t* p10 = src + (srcY0 * srcW + srcX1) * 4;
                const uint8_t* p01 = src + (srcY1 * srcW + srcX0) * 4;
                const uint8_t* p11 = src + (srcY1 * srcW + srcX1) * 4;

                uint8_t* out = dst + (dy * dstW + dx) * 4;

                for (int c = 0; c < 4; ++c) {
                    float top = static_cast<float>(Lerp(p00[c], p10[c], tx));
                    float bot = static_cast<float>(Lerp(p01[c], p11[c], tx));
                    out[c] = static_cast<uint8_t>(top + (bot - top) * ty);
                }
            }
        }
    }

    bool initialized_ = false;
    uint32_t inputWidth_ = 0;
    uint32_t inputHeight_ = 0;
    uint32_t outputWidth_ = 0;
    uint32_t outputHeight_ = 0;
};

// ─── Global configuration (set by --serve commands) ───────────────────

static struct {
    std::string sessionId;
    std::string authToken;
    uint32_t inputWidth = 1920;
    uint32_t inputHeight = 1080;
    uint32_t outputWidth = 1920;
    uint32_t outputHeight = 1080;
    uint32_t processingMode = 1; // 1=VSR
    uint32_t qualityLevel = 2;   // 2=high
    bool configured = false;
} g_config;

static ProcessingContext g_processor;

// ─── Helper: create JSON response ─────────────────────────────────────

static sv::JsonObject MakeResponse(bool success, const std::string& errorMsg = "") {
    sv::JsonObject resp;
    resp["success"] = sv::JsonValue(success);
    if (!errorMsg.empty()) {
        resp["error"] = sv::JsonValue(errorMsg);
    }
    return resp;
}

// ─── Command handlers ─────────────────────────────────────────────────

static bool HandleHello(const sv::JsonObject& payload) {
    auto proto = sv::GetString(payload, "protocolVersion");
    auto sid = sv::GetString(payload, "sessionId");
    auto token = sv::GetString(payload, "authToken");

    if (!proto || !sid || !token) {
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
    g_config.inputWidth = static_cast<uint32_t>(
        sv::GetNumber(payload, "inputWidth", 1920));
    g_config.inputHeight = static_cast<uint32_t>(
        sv::GetNumber(payload, "inputHeight", 1080));
    g_config.outputWidth = static_cast<uint32_t>(
        sv::GetNumber(payload, "outputWidth", 1920));
    g_config.outputHeight = static_cast<uint32_t>(
        sv::GetNumber(payload, "outputHeight", 1080));
    g_config.processingMode = static_cast<uint32_t>(
        sv::GetNumber(payload, "processingMode", 1));
    g_config.qualityLevel = static_cast<uint32_t>(
        sv::GetNumber(payload, "qualityLevel", 2));

    g_processor.Shutdown();
    bool ok = g_processor.Initialize(g_config.inputWidth, g_config.inputHeight,
                                     g_config.outputWidth, g_config.outputHeight);
    g_config.configured = ok;

    printf("[Serve] Configured: %ux%u -> %ux%u mode=%u quality=%u %s\n",
           g_config.inputWidth, g_config.inputHeight,
           g_config.outputWidth, g_config.outputHeight,
           g_config.processingMode, g_config.qualityLevel,
           ok ? "OK" : "FAILED");
    return ok;
}

static bool HandleSubmitFrame(const sv::JsonObject& /*payload*/,
                               sv::FrameTransport& transport) {
    if (!g_config.configured) {
        fprintf(stderr, "[Serve] submit-frame: not configured\n");
        return false;
    }

    // Read frame from frame pipe
    sv::FrameHeader header;
    std::vector<uint8_t> frameData;

    if (!transport.ReadFrame(header, frameData)) {
        fprintf(stderr, "[Serve] submit-frame: read failed\n");
        return false;
    }

    // Validate frame dimensions (allow auto-detection from header)
    uint32_t inW = header.inputWidth ? header.inputWidth : g_config.inputWidth;
    uint32_t inH = header.inputHeight ? header.inputHeight : g_config.inputHeight;
    uint32_t outW = header.requestedOutputWidth ? header.requestedOutputWidth : g_config.outputWidth;
    uint32_t outH = header.requestedOutputHeight ? header.requestedOutputHeight : g_config.outputHeight;

    // Allocate output buffer
    uint32_t outSize = outW * outH * 4;
    std::vector<uint8_t> outputData(outSize);

    // Process frame (CPU-staging bilinear upscale)
    auto start = std::chrono::steady_clock::now();

    // If dimensions differ, reinitialize processing context
    if (inW != g_config.inputWidth || inH != g_config.inputHeight ||
        outW != g_config.outputWidth || outH != g_config.outputHeight) {
        g_processor.Shutdown();
        g_processor.Initialize(inW, inH, outW, outH);
        g_config.inputWidth = inW;
        g_config.inputHeight = inH;
        g_config.outputWidth = outW;
        g_config.outputHeight = outH;
    }

    bool processOk = g_processor.ProcessFrame(
        frameData.data(), static_cast<uint32_t>(frameData.size()),
        outputData.data(), outSize);

    auto end = std::chrono::steady_clock::now();
    uint64_t elapsedUs = std::chrono::duration_cast<std::chrono::microseconds>(end - start).count();

    // Record diagnostics
    sv::GetDiagnosticsCounters().RecordFrame(elapsedUs, processOk);

    // Write result back
    sv::FrameHeader resultHeader = header;
    resultHeader.resultCode = processOk ? 1 : 2;
    resultHeader.payloadBytes = outSize;

    if (!transport.WriteFrame(resultHeader, outputData.data(), outSize)) {
        fprintf(stderr, "[Serve] submit-frame: write result failed\n");
        return false;
    }

    printf("[Serve] Frame %u processed: %ux%u -> %ux%u in %lluus %s\n",
           header.frameSequence, inW, inH, outW, outH,
           (unsigned long long)elapsedUs,
           processOk ? "OK" : "FAILED");

    return processOk;
}

static sv::DiagnosticSnapshot BuildStatsResponse() {
    auto snap = sv::GetDiagnostics();
    auto& ctr = sv::GetDiagnosticsCounters();
    snap.uptimeMs = 0; // Phase 7+: track uptime
    return snap;
}

// ─── Serve mode main loop ─────────────────────────────────────────────

static int RunServe(const std::vector<std::string>& args) {
    // Parse CLI arguments
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

    // Create named pipe servers
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

    // Main connection loop (handle one client at a time)
    while (true) {
        // Wait for control client
        if (!transport.WaitForClient(transport.GetControlPipe())) {
            fprintf(stderr, "[Serve] Control pipe connection failed, retrying...\n");
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            continue;
        }

        printf("[Serve] Control client connected\n");

        // Process commands for this client
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

            auto* cmdStr = sv::GetString(req, "command");
            if (!cmdStr) {
                transport.WriteControlResponse(
                    sv::SerializeJson(MakeResponse(false, "Missing 'command' field")));
                continue;
            }

            auto cmd = sv::ParseCommand(*cmdStr);

            // Extract payload (or use empty object)
            sv::JsonObject payload;
            auto* payloadStr = sv::GetString(req, "payload");
            if (payloadStr) {
                try {
                    // Payload might be a nested JSON object string
                    payload = sv::ParseJson(*payloadStr);
                } catch (...) {
                    // Empty payload
                }
            }

            // Dispatch command
            sv::JsonObject response;
            bool success = false;

            switch (cmd) {
                case sv::Command::kHello:
                    // Use entire request as payload since payload is embedded at top level
                    success = HandleHello(req);
                    response = MakeResponse(success, success ? "" : "Authentication failed");
                    break;

                case sv::Command::kConfigure: {
                    // For configure, payload is embedded in the request
                    success = HandleConfigure(req);
                    response = MakeResponse(success, success ? "" : "Configuration failed");
                    break;
                }

                case sv::Command::kFrameAvailable: {
                    // Submit frame: need to connect frame pipe
                    if (!transport.WaitForClient(transport.GetFramePipe())) {
                        fprintf(stderr, "[Serve] Frame pipe connection failed\n");
                        response = MakeResponse(false, "Frame pipe connection failed");
                    } else {
                        success = HandleSubmitFrame(req, transport);
                        response = MakeResponse(success, success ? "" : "Frame processing failed");
                        // Disconnect frame pipe for next frame
                        DisconnectNamedPipe(transport.GetFramePipe());
                    }
                    break;
                }

                case sv::Command::kFlush:
                    // No-op for CPU-staging
                    response = MakeResponse(true);
                    break;

                case sv::Command::kStats: {
                    auto stats = BuildStatsResponse();
                    sv::JsonObject resp;
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
                    transport.WriteControlResponse(
                        sv::SerializeJson(MakeResponse(true)));
                    transport.CloseControlPipe();
                    transport.CloseFramePipe();
                    g_processor.Shutdown();
                    return 0;

                default:
                    fprintf(stderr, "[Serve] Unknown command: %s\n", cmdStr->c_str());
                    response = MakeResponse(false, "Unknown command");
                    break;
            }

            // Send response
            auto responseStr = sv::SerializeJson(response);
            transport.WriteControlResponse(responseStr);
        }

        // Disconnect and wait for next client
        DisconnectNamedPipe(transport.GetControlPipe());
        printf("[Serve] Waiting for next client...\n");
    }

    return 0;
}

// ─── Stubs for other modes ────────────────────────────────────────────

static void PrintVersion() {
    printf("{\n");
    printf("  \"name\": \"screenlink-video-enhancer\",\n");
    printf("  \"version\": \"0.1.0\",\n");
    printf("  \"protocolVersion\": \"%s\",\n", sv::kProtocolVersion.data());
    printf("  \"build\": {\n");
    printf("    \"commit\": \"%s\",\n", BUILD_GIT_COMMIT);
    printf("    \"dirty\": %s,\n", BUILD_GIT_DIRTY ? "true" : "false");
    printf("    \"branch\": \"%s\",\n", BUILD_GIT_BRANCH);
    printf("    \"timestamp\": \"%s\",\n", BUILD_TIMESTAMP);
    printf("    \"configuration\": \"%s\",\n", BUILD_CONFIG);
    printf("    \"compiler\": \"%s\"\n", BUILD_COMPILER_ID);
    printf("  }\n");
    printf("}\n");
}

static int RunCapabilities() {
    auto result = sv::ProbeCapability();
    printf("{\n");
    printf("  \"available\": %s,\n", result.available ? "true" : "false");
    printf("  \"reason\": \"%s\",\n", result.reason.c_str());
    printf("  \"adapterName\": \"%s\",\n", result.adapterName.c_str());
    printf("  \"driverVersion\": \"%s\"\n", result.driverVersion.c_str());
    printf("}\n");
    return result.available ? 0 : 1;
}

static int RunSelfTest() {
    bool allPassed = true;

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

    // Test JSON parser
    try {
        auto obj = sv::ParseJson(R"({"hello":"world","num":42,"flag":true,"null":null})");
        allPassed &= (sv::GetString(obj, "hello") != nullptr);
        allPassed &= (*sv::GetString(obj, "hello") == "world");
        allPassed &= (sv::GetNumber(obj, "num") == 42.0);
        allPassed &= (sv::GetBool(obj, "flag") == true);
    } catch (...) {
        allPassed = false;
    }

    // Test JSON serializer round-trip
    try {
        sv::JsonObject obj;
        obj["test"] = sv::JsonValue(std::string("value"));
        auto json = sv::SerializeJson(obj);
        auto parsed = sv::ParseJson(json);
        auto* val = sv::GetString(parsed, "test");
        allPassed &= (val != nullptr && *val == "value");
    } catch (...) {
        allPassed = false;
    }

    // Test VSR context CPU-staging
    {
        sv::NvidiaVsrContext ctx;
        allPassed &= ctx.Initialize(4, 4, 8, 8);
        uint8_t src[64];
        uint8_t dst[256];
        for (int i = 0; i < 64; ++i) src[i] = static_cast<uint8_t>(i);
        allPassed &= ctx.ProcessFrame(src, 64, dst, 256);
        ctx.Shutdown();
        allPassed &= !ctx.IsInitialized();
    }

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
