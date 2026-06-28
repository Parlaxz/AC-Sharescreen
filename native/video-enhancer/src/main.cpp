#include "BuildInfo.h"
#include "Protocol.h"
#include "CapabilityProbe.h"
#include "FrameTransport.h"
#include "NvidiaVsrContext.h"

#include <cstdio>
#include <cstdlib>
#include <string>
#include <string_view>
#include <vector>

/// Print version JSON to stdout.
static void PrintVersion() {
    printf("{\n");
    printf("  \"name\": \"screenlink-video-enhancer\",\n");
    printf("  \"version\": \"0.1.0\",\n");
    printf("  \"protocolVersion\": \"%s\",\n", screenlink::video::kProtocolVersion.data());
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

/// Run capability probe and print JSON result to stdout.
static int RunCapabilities() {
    auto result = screenlink::video::ProbeCapability();
    printf("{\n");
    printf("  \"available\": %s,\n", result.available ? "true" : "false");
    printf("  \"reason\": \"%s\",\n", result.reason.c_str());
    printf("  \"adapterName\": \"%s\",\n", result.adapterName.c_str());
    printf("  \"driverVersion\": \"%s\"\n", result.driverVersion.c_str());
    printf("}\n");
    return result.available ? 0 : 1;
}

/// Run built-in self-tests.
static int RunSelfTest() {
    bool allPassed = true;

    // Test protocol parsing
    auto cmd = screenlink::video::ParseCommand("hello");
    allPassed &= (cmd == screenlink::video::Command::kHello);

    cmd = screenlink::video::ParseCommand("unknown_command");
    allPassed &= (cmd == screenlink::video::Command::kUnknown);

    cmd = screenlink::video::ParseCommand("shutdown");
    allPassed &= (cmd == screenlink::video::Command::kShutdown);

    // Test command name conversion
    auto name = screenlink::video::CommandName(screenlink::video::Command::kCapabilities);
    allPassed &= (name == "capabilities");

    name = screenlink::video::CommandName(screenlink::video::Command::kUnknown);
    allPassed &= (name == "unknown");

    // Test protocol version is non-empty
    allPassed &= !screenlink::video::kProtocolVersion.empty();

    printf("Self-tests: %s\n", allPassed ? "ALL PASSED" : "FAILED");
    return allPassed ? 0 : 1;
}

/// Run persistent serve mode (daemon).
/// Phase 7+ will flesh out the full implementation.
static int RunServe(const std::vector<std::string>& args) {
    // Parse --control-pipe, --frame-pipe, --session-id, --auth-token
    std::string ctrlPipe, framePipe, sessionId, authToken;

    for (size_t i = 0; i < args.size(); ++i) {
        if (args[i] == "--control-pipe" && i + 1 < args.size())
            ctrlPipe = args[++i];
        else if (args[i] == "--frame-pipe" && i + 1 < args.size())
            framePipe = args[++i];
        else if (args[i] == "--session-id" && i + 1 < args.size())
            sessionId = args[++i];
        else if (args[i] == "--auth-token" && i + 1 < args.size())
            authToken = args[++i];
    }

    if (ctrlPipe.empty() || framePipe.empty() || sessionId.empty() || authToken.empty()) {
        fprintf(stderr, "Missing required arguments for --serve\n");
        return static_cast<int>(screenlink::video::ExitCode::kServeFailed);
    }

    printf("Video-enhancer serve mode started\n");
    printf("  Control pipe: %s\n", ctrlPipe.c_str());
    printf("  Frame pipe: %s\n", framePipe.c_str());
    printf("  Session: %s\n", sessionId.c_str());

    // Phase 7: Implement full serve mode with named pipe server + frame ring
    fprintf(stderr, "Serve mode not yet fully implemented (Phase 7)\n");
    return static_cast<int>(screenlink::video::ExitCode::kServeFailed);
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
    if (args[0] == "--self-test") { return RunSelfTest(); }
    if (args[0] == "--serve") { return RunServe(args); }

    fprintf(stderr, "Unknown command: %s\n", args[0].c_str());
    return static_cast<int>(screenlink::video::ExitCode::kUnknownCommand);
}
