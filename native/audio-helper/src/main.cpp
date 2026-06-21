#include "Protocol.h"
#include <iostream>
#include <cstdlib>

int main(int argc, char* argv[]) {
  if (argc < 2) {
    std::cerr << "Usage: screenlink-audio-helper.exe --version|--capabilities|--self-test\n";
    return static_cast<int>(screenlink::audio::ExitCode::kUnknownCommand);
  }

  const auto cmd = screenlink::audio::ParseCommand(argv[1]);

  switch (cmd) {
    case screenlink::audio::Command::kVersion: {
      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"status\": \"ok\"\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
    }

    case screenlink::audio::Command::kCapabilities: {
      // Phase 2A: capabilities are partial stubs — full detection in Task 2A.2
      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"architecture\": \"x64\",\n";
      std::cout << "  \"status\": \"ok\",\n";
      std::cout << "  \"operatingSystem\": \"Windows\",\n";
      std::cout << "  \"osVersion\": {\n";
      std::cout << "    \"major\": 0,\n";
      std::cout << "    \"minor\": 0,\n";
      std::cout << "    \"build\": 0,\n";
      std::cout << "    \"revision\": 0\n";
      std::cout << "  },\n";
      std::cout << "  \"detectionMethod\": \"not-implemented\",\n";
      std::cout << "  \"detectionSucceeded\": false,\n";
      std::cout << "  \"compiledWindowsSdkVersion\": \"0.0.0.0\",\n";
      std::cout << "  \"processLoopbackHeadersAvailable\": false,\n";
      std::cout << "  \"processLoopbackRuntimeSupported\": false,\n";
      std::cout << "  \"applicationLoopbackSupported\": false,\n";
      std::cout << "  \"usable\": false,\n";
      std::cout << "  \"reasonCode\": \"detection-not-implemented\",\n";
      std::cout << "  \"reasonMessage\": \"Windows version detection not yet implemented\"\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
    }

    case screenlink::audio::Command::kSelfTest: {
      // Phase 2A self-test: only tests what exists (protocol, serialization)
      // Full detection testing added in Task 2A.2
      bool allPassed = true;

      // Test 1: Protocol version is non-empty
      if (screenlink::audio::kProtocolVersion.empty()) {
        std::cerr << "FAIL: kProtocolVersion is empty\n";
        allPassed = false;
      }

      // Test 2: Helper version is non-empty
      if (screenlink::audio::kHelperVersion.empty()) {
        std::cerr << "FAIL: kHelperVersion is empty\n";
        allPassed = false;
      }

      // Test 3: ParseCommand works
      if (screenlink::audio::ParseCommand("--version") != screenlink::audio::Command::kVersion) {
        std::cerr << "FAIL: ParseCommand('--version') mismatch\n";
        allPassed = false;
      }
      if (screenlink::audio::ParseCommand("--capabilities") != screenlink::audio::Command::kCapabilities) {
        std::cerr << "FAIL: ParseCommand('--capabilities') mismatch\n";
        allPassed = false;
      }
      if (screenlink::audio::ParseCommand("--self-test") != screenlink::audio::Command::kSelfTest) {
        std::cerr << "FAIL: ParseCommand('--self-test') mismatch\n";
        allPassed = false;
      }
      if (screenlink::audio::ParseCommand("--unknown") != screenlink::audio::Command::kUnknown) {
        std::cerr << "FAIL: ParseCommand('--unknown') mismatch\n";
        allPassed = false;
      }

      if (allPassed) {
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"ok\",\n";
        std::cout << "  \"selfTestPassed\": true\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
      } else {
        std::cerr << "One or more self-tests failed\n";
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"error\",\n";
        std::cout << "  \"selfTestPassed\": false\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kSelfTestFailed);
      }
    }

    case screenlink::audio::Command::kUnknown:
    default: {
      std::cerr << "Unknown command: " << argv[1] << "\n";
      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"status\": \"error\",\n";
      std::cout << "  \"error\": \"unknown-command\"\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kUnknownCommand);
    }
  }
}
