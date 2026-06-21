#include "Protocol.h"
#include "WindowsVersion.h"
#include "AudioCapabilities.h"
#include <iostream>

int main(int argc, char* argv[]) {
  if (argc < 2 || argc > 2) {
    std::cerr << "Usage: screenlink-audio-helper.exe --version|--capabilities|--self-test\n";
    std::cout << "{\n"
              << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n"
              << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n"
              << "  \"status\": \"error\",\n"
              << "  \"error\": \"invalid-arguments\"\n"
              << "}\n";
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
      auto osInfo = screenlink::audio::DetectWindowsVersion();
      auto compileTime = screenlink::audio::DetectCompileTimeSupport();
      auto runtime = screenlink::audio::DetectRuntimeSupport(osInfo);
      auto cap = screenlink::audio::ComputeCapability(compileTime, runtime);

      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"architecture\": \"" << (runtime.is64BitProcess ? "x64" : "x86") << "\",\n";
      std::cout << "  \"status\": \"ok\",\n";
      std::cout << "  \"operatingSystem\": \"Windows\",\n";
      std::cout << "  \"osVersion\": {\n";
      std::cout << "    \"major\": " << osInfo.major << ",\n";
      std::cout << "    \"minor\": " << osInfo.minor << ",\n";
      std::cout << "    \"build\": " << osInfo.build << ",\n";
      std::cout << "    \"revision\": " << osInfo.revision << "\n";
      std::cout << "  },\n";
      std::cout << "  \"detectionMethod\": \"" << osInfo.detectionMethod << "\",\n";
      std::cout << "  \"detectionSucceeded\": " << (osInfo.succeeded ? "true" : "false") << ",\n";
      std::cout << "  \"compiledWindowsSdkVersion\": \""
                << compileTime.windowsSdkVersion << "\",\n";
      std::cout << "  \"processLoopbackHeadersAvailable\": "
                << (compileTime.headersAvailable ? "true" : "false") << ",\n";
      std::cout << "  \"processLoopbackRuntimeSupported\": "
                << (runtime.osBuildEligible ? "true" : "false") << ",\n";
      std::cout << "  \"applicationLoopbackSupported\": "
                << (cap.usable ? "true" : "false") << ",\n";
      std::cout << "  \"usable\": " << (cap.usable ? "true" : "false") << ",\n";
      std::cout << "  \"is64BitProcess\": "
                << (runtime.is64BitProcess ? "true" : "false") << ",\n";
      std::cout << "  \"is64BitOperatingSystem\": "
                << (runtime.is64BitOperatingSystem ? "true" : "false") << ",\n";
      std::cout << "  \"reasonCode\": \"" << cap.reasonCode << "\",\n";
      std::cout << "  \"reasonMessage\": \"" << cap.reasonMessage << "\"\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
    }

    case screenlink::audio::Command::kSelfTest: {
      bool allPassed = true;

      // ── Protocol tests ──
      if (screenlink::audio::kProtocolVersion.empty()) {
        std::cerr << "FAIL: kProtocolVersion is empty\n";
        allPassed = false;
      }

      if (screenlink::audio::kHelperVersion.empty()) {
        std::cerr << "FAIL: kHelperVersion is empty\n";
        allPassed = false;
      }

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

      // ── Windows version detection tests ──
      auto osInfo = screenlink::audio::DetectWindowsVersion();
      if (!osInfo.succeeded) {
        std::cerr << "FAIL: DetectWindowsVersion() returned: "
                  << osInfo.failureReason << "\n";
        allPassed = false;
      }
      if (osInfo.major == 0 && osInfo.minor == 0 && osInfo.build == 0) {
        std::cerr << "FAIL: DetectWindowsVersion() returned all zeros\n";
        allPassed = false;
      }
      if (osInfo.detectionMethod.empty()) {
        std::cerr << "FAIL: DetectWindowsVersion() detectionMethod is empty\n";
        allPassed = false;
      }

      // ── Compile-time support detection tests ──
      auto compileTime = screenlink::audio::DetectCompileTimeSupport();
      if (compileTime.windowsSdkVersion.empty()) {
        std::cerr << "FAIL: windowsSdkVersion is empty\n";
        allPassed = false;
      }

      // ── Runtime support detection tests ──
      auto runtime = screenlink::audio::DetectRuntimeSupport(osInfo);
      if (!runtime.is64BitProcess) {
        std::cerr << "FAIL: is64BitProcess should be true\n";
        allPassed = false;
      }
      if (!runtime.is64BitOperatingSystem) {
        std::cerr << "FAIL: is64BitOperatingSystem should be true on x64 Windows\n";
        allPassed = false;
      }
      if (runtime.osBuildNumber == 0) {
        std::cerr << "FAIL: osBuildNumber should be non-zero\n";
        allPassed = false;
      }

      // ── Capability computation tests ──
      auto cap = screenlink::audio::ComputeCapability(compileTime, runtime);
      if (cap.reasonCode.empty()) {
        std::cerr << "FAIL: reasonCode should not be empty\n";
        allPassed = false;
      }
      if (cap.reasonMessage.empty()) {
        std::cerr << "FAIL: reasonMessage should not be empty\n";
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
