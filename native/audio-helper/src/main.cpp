#include "Protocol.h"
#include "WindowsVersion.h"
#include "AudioCapabilities.h"
#include "WindowEnumerator.h"
#include "ProcessResolver.h"
#include "SourceMapper.h"
#include "WavWriter.h"
#include "LoopbackCapture.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

// ── JSON string escaping ──
// Escapes ", \, newlines, tabs, and other control characters for safe JSON output.
std::string JsonEscape(const std::string& s) {
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
        // Escape control characters (U+0000–U+001F) as \uXXXX
        if (static_cast<unsigned char>(ch) < 0x20) {
          char buf[8] = {};
          snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(ch));
          out += buf;
        } else {
          out += ch;
        }
        break;
    }
  }
  return out;
}

// Common JSON error output helper.
void PrintError(const char* errorMsg, int& exitCodeOut, int exitCode) {
  std::cout << "{\n";
  std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
  std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
  std::cout << "  \"status\": \"error\",\n";
  std::cout << "  \"error\": \"" << errorMsg << "\"\n";
  std::cout << "}\n";
  exitCodeOut = exitCode;
}

} // anonymous namespace

int main(int argc, char* argv[]) {
  if (argc < 2) {
    std::cerr << "Usage: screenlink-audio-helper.exe --version|--capabilities|--self-test|--enumerate-windows|--enumerate-sources|--resolve-process-tree <pid>|--capture-test <pid> [--duration-ms <ms>] [--output <path>] [--mode include|exclude]\n";
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
      if (screenlink::audio::ParseCommand("--enumerate-windows") != screenlink::audio::Command::kEnumerateWindows) {
        std::cerr << "FAIL: ParseCommand('--enumerate-windows') mismatch\n";
        allPassed = false;
      }
      if (screenlink::audio::ParseCommand("--enumerate-sources") != screenlink::audio::Command::kEnumerateSources) {
        std::cerr << "FAIL: ParseCommand('--enumerate-sources') mismatch\n";
        allPassed = false;
      }
      if (screenlink::audio::ParseCommand("--resolve-process-tree") != screenlink::audio::Command::kResolveProcessTree) {
        std::cerr << "FAIL: ParseCommand('--resolve-process-tree') mismatch\n";
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

      // ── Process-loopback build-boundary tests ──
      struct BuildBoundaryCase {
        uint32_t build;
        const char* label;
        bool expectedUsable;
        const char* expectedReasonCode;
      };

      auto sdkOk = compileTime;

      const BuildBoundaryCase kCases[] = {
        { 20347, "20347 (one below minimum)", false, "unsupported-windows-build" },
        { 20348, "20348 (exactly minimum)",    true,  nullptr },
        { 20349, "20349 (one above minimum)",   true,  nullptr },
        { 21999, "21999 (below 22000, above 20348)", true, nullptr },
        { 22000, "22000 (Windows 11 RTM)",      true,  nullptr },
        { 19045, "19045 (Windows 10 22H2)",     false, "unsupported-windows-build" },
      };

      for (const auto& bc : kCases) {
        screenlink::audio::WindowsVersionResult fakeOs;
        fakeOs.major = 10;
        fakeOs.minor = 0;
        fakeOs.build = bc.build;
        fakeOs.revision = 0;
        fakeOs.succeeded = true;
        fakeOs.detectionMethod = "simulated";

        auto fakeRuntime = screenlink::audio::DetectRuntimeSupport(fakeOs);
        auto bcCap = screenlink::audio::ComputeCapability(sdkOk, fakeRuntime);

        if (bcCap.usable != bc.expectedUsable) {
          std::cerr << "FAIL: build-boundary [" << bc.label << "] usable="
                    << (bcCap.usable ? "true" : "false")
                    << " (expected " << (bc.expectedUsable ? "true" : "false") << ")\n";
          allPassed = false;
        }

        if (!bc.expectedUsable && bc.expectedReasonCode != nullptr) {
          if (bcCap.reasonCode != bc.expectedReasonCode) {
            std::cerr << "FAIL: build-boundary [" << bc.label << "] reasonCode='"
                      << bcCap.reasonCode << "' (expected '"
                      << bc.expectedReasonCode << "')\n";
            allPassed = false;
          }
        }
      }

      // ── Window enumerator test ──
      {
        auto enumResult = screenlink::audio::EnumerateWindows();
        if (!enumResult.succeeded) {
          std::cerr << "FAIL: EnumerateWindows() failed: "
                    << enumResult.failureReason << "\n";
          allPassed = false;
        } else if (enumResult.windows.empty()) {
          std::cerr << "FAIL: EnumerateWindows() returned no windows\n";
          allPassed = false;
        } else {
          // Verify at least some windows have valid data
          bool foundValidProcess = false;
          for (const auto& w : enumResult.windows) {
            if (w.processId != 0 && !w.processPath.empty()) {
              foundValidProcess = true;
              break;
            }
          }
          if (!foundValidProcess) {
            std::cerr << "FAIL: EnumerateWindows() returned windows but none have valid process info\n";
            allPassed = false;
          }
        }
      }

      // ── Source enumeration test ──
      {
        auto sourceResult = screenlink::audio::EnumerateAudioSources();
        if (!sourceResult.succeeded) {
          std::cerr << "FAIL: EnumerateAudioSources() failed: "
                    << sourceResult.failureReason << "\n";
          allPassed = false;
        } else if (sourceResult.sources.empty()) {
          std::cerr << "FAIL: EnumerateAudioSources() returned no sources\n";
          allPassed = false;
        } else {
          for (const auto& s : sourceResult.sources) {
            if (s.sourceId.empty()) {
              std::cerr << "FAIL: EnumerateAudioSources() source has empty sourceId\n";
              allPassed = false;
            }
            // processName may be empty if processPath could not be resolved;
            // only require it when the path is non-empty.
            if (!s.processPath.empty() && s.processName.empty()) {
              std::cerr << "FAIL: EnumerateAudioSources() source has empty processName with non-empty path\n";
              allPassed = false;
            }
          }
        }
      }

      // ── Process tree resolution test ──
      {
        DWORD currentPid = GetCurrentProcessId();
        auto treeResult = screenlink::audio::ResolveProcessTree(
            static_cast<uint32_t>(currentPid));
        if (!treeResult.succeeded) {
          std::cerr << "FAIL: ResolveProcessTree(current PID) failed: "
                    << treeResult.failureReason << "\n";
          allPassed = false;
        } else if (treeResult.processes.empty()) {
          std::cerr << "FAIL: ResolveProcessTree() returned empty chain\n";
          allPassed = false;
        } else {
          // Verify the first entry is the current process
          if (treeResult.processes[0].processId != static_cast<uint32_t>(currentPid)) {
            std::cerr << "FAIL: ResolveProcessTree() first entry should be current PID\n";
            allPassed = false;
          }
          // Current process should have a valid path
          if (treeResult.processes[0].processPath.empty()) {
            std::cerr << "FAIL: ResolveProcessTree() current process path is empty\n";
            allPassed = false;
          }
        }
      }

      // ── Process-loopback support test ──
      {
        bool supported = screenlink::audio::IsProcessLoopbackSupported();
        // Verify it returns a consistent result (deterministic per session)
        if (supported != screenlink::audio::IsProcessLoopbackSupported()) {
          std::cerr << "FAIL: IsProcessLoopbackSupported() returned inconsistent results\n";
          allPassed = false;
        }
      }

      // ── WavWriter test ──
      {
        screenlink::audio::WavWriter testWriter;
        std::string testWavPath = "test-wavwriter.wav";
        bool wavOk = testWriter.Open(testWavPath, 48000, 2, 32);
        if (!wavOk) {
          std::cerr << "FAIL: WavWriter::Open failed\n";
          allPassed = false;
        } else {
          // Write 480 frames (10ms at 48kHz) of silence
          std::vector<float> testFrames(480 * 2, 0.0f);
          wavOk = testWriter.WriteFrames(testFrames.data(), 480);
          if (!wavOk) {
            std::cerr << "FAIL: WavWriter::WriteFrames failed\n";
            allPassed = false;
          }
          wavOk = testWriter.Close();
          if (!wavOk) {
            std::cerr << "FAIL: WavWriter::Close failed\n";
            allPassed = false;
          } else {
            // Verify the file exists after Close
            DWORD attrs = GetFileAttributesA(testWavPath.c_str());
            if (attrs == INVALID_FILE_ATTRIBUTES) {
              std::cerr << "FAIL: WavWriter output file not found after Close()\n";
              allPassed = false;
            }
            // Verify expected file size: 44 (header) + 480*2*4 (data) = 3884
            if (attrs != INVALID_FILE_ATTRIBUTES) {
              HANDLE hFile = CreateFileA(testWavPath.c_str(), GENERIC_READ,
                                          FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                          FILE_ATTRIBUTE_NORMAL, nullptr);
              if (hFile != INVALID_HANDLE_VALUE) {
                LARGE_INTEGER fileSize;
                if (GetFileSizeEx(hFile, &fileSize)) {
                  constexpr int64_t kExpectedSize = 44 + 480 * 2 * 4; // 3884
                  if (fileSize.QuadPart != kExpectedSize) {
                    std::cerr << "FAIL: WavWriter file size is " << fileSize.QuadPart
                              << " (expected " << kExpectedSize << ")\n";
                    allPassed = false;
                  }
                }
                CloseHandle(hFile);
              }
            }
          }
          // Clean up temp file
          DeleteFileA(testWavPath.c_str());
        }
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

    case screenlink::audio::Command::kEnumerateWindows: {
      auto result = screenlink::audio::EnumerateWindows();
      if (!result.succeeded) {
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"error\",\n";
        std::cout << "  \"error\": \"" << JsonEscape(result.failureReason) << "\"\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kEnumerationFailed);
      }

      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"status\": \"ok\",\n";
      std::cout << "  \"windowCount\": " << result.windows.size() << ",\n";
      std::cout << "  \"windows\": [\n";
      for (size_t i = 0; i < result.windows.size(); ++i) {
        const auto& w = result.windows[i];
        std::cout << "    {\n";
        std::cout << "      \"hwnd\": " << w.hwnd << ",\n";
        std::cout << "      \"processId\": " << w.processId << ",\n";
        std::cout << "      \"processPath\": \"" << JsonEscape(w.processPath) << "\",\n";
        std::cout << "      \"windowTitle\": \"" << JsonEscape(w.windowTitle) << "\",\n";
        std::cout << "      \"windowClass\": \"" << JsonEscape(w.windowClass) << "\",\n";
        std::cout << "      \"isVisible\": " << (w.isVisible ? "true" : "false") << ",\n";
        std::cout << "      \"isCloaked\": " << (w.isCloaked ? "true" : "false") << "\n";
        std::cout << "    }";
        if (i < result.windows.size() - 1) std::cout << ",";
        std::cout << "\n";
      }
      std::cout << "  ]\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
    }

    case screenlink::audio::Command::kEnumerateSources: {
      auto result = screenlink::audio::EnumerateAudioSources();
      if (!result.succeeded) {
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"error\",\n";
        std::cout << "  \"error\": \"" << JsonEscape(result.failureReason) << "\"\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kSourceEnumerationFailed);
      }

      // Helper to convert ElectronConfidence to string.
      auto enumToString = [](screenlink::audio::ElectronConfidence c) -> const char* {
        switch (c) {
          case screenlink::audio::ElectronConfidence::kNone:        return "none";
          case screenlink::audio::ElectronConfidence::kProcessName: return "process-name";
          case screenlink::audio::ElectronConfidence::kLow:         return "low";
          default:                                                  return "none";
        }
      };

      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"status\": \"ok\",\n";
      std::cout << "  \"sourceCount\": " << result.sources.size() << ",\n";
      std::cout << "  \"sources\": [\n";
      for (size_t i = 0; i < result.sources.size(); ++i) {
        const auto& s = result.sources[i];
        std::cout << "    {\n";
        std::cout << "      \"sourceId\": \"" << JsonEscape(s.sourceId) << "\",\n";
        std::cout << "      \"displayName\": \"" << JsonEscape(s.displayName) << "\",\n";
        std::cout << "      \"processId\": " << s.processId << ",\n";
        std::cout << "      \"hwnd\": " << s.hwnd << ",\n";
        std::cout << "      \"processPath\": \"" << JsonEscape(s.processPath) << "\",\n";
        std::cout << "      \"processName\": \"" << JsonEscape(s.processName) << "\",\n";
        std::cout << "      \"isElectron\": " << (s.isElectron ? "true" : "false") << ",\n";
        std::cout << "      \"electronConfidence\": \"" << enumToString(s.electronConfidence) << "\",\n";
        std::cout << "      \"windowTitle\": \"" << JsonEscape(s.windowTitle) << "\",\n";
        std::cout << "      \"windowClass\": \"" << JsonEscape(s.windowClass) << "\",\n";
        std::cout << "      \"isVisible\": " << (s.isVisible ? "true" : "false") << ",\n";
        std::cout << "      \"isCloaked\": " << (s.isCloaked ? "true" : "false") << ",\n";
        std::cout << "      \"hasAudio\": " << (s.hasAudio ? "true" : "false") << "\n";
        std::cout << "    }";
        if (i < result.sources.size() - 1) std::cout << ",";
        std::cout << "\n";
      }
      std::cout << "  ]\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
    }

    case screenlink::audio::Command::kResolveProcessTree: {
      if (argc < 3) {
        std::cerr << "Missing PID argument for --resolve-process-tree\n";
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"error\",\n";
        std::cout << "  \"error\": \"missing-pid-argument\"\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kProcessResolutionFailed);
      }

      uint32_t targetPid = 0;
      try {
        targetPid = static_cast<uint32_t>(std::stoul(argv[2]));
      } catch (const std::exception&) {
        std::cerr << "Invalid PID argument: " << argv[2] << "\n";
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"error\",\n";
        std::cout << "  \"error\": \"invalid-pid-argument\"\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kProcessResolutionFailed);
      }

      auto result = screenlink::audio::ResolveProcessTree(targetPid);
      if (!result.succeeded) {
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"error\",\n";
        std::cout << "  \"error\": \"" << JsonEscape(result.failureReason) << "\"\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kProcessResolutionFailed);
      }

      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"status\": \"ok\",\n";
      std::cout << "  \"targetPid\": " << result.targetPid << ",\n";
      std::cout << "  \"processChainDepth\": " << result.processes.size() << ",\n";
      std::cout << "  \"processes\": [\n";
      for (size_t i = 0; i < result.processes.size(); ++i) {
        const auto& p = result.processes[i];
        std::cout << "    {\n";
        std::cout << "      \"processId\": " << p.processId << ",\n";
        std::cout << "      \"parentProcessId\": " << p.parentProcessId << ",\n";
        std::cout << "      \"processPath\": \"" << JsonEscape(p.processPath) << "\",\n";
        std::cout << "      \"processName\": \"" << JsonEscape(p.processName) << "\"\n";
        std::cout << "    }";
        if (i < result.processes.size() - 1) std::cout << ",";
        std::cout << "\n";
      }
      std::cout << "  ]\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
    }

    case screenlink::audio::Command::kCaptureTest: {
      if (argc < 3) {
        int exitCode = static_cast<int>(screenlink::audio::ExitCode::kCaptureTestFailed);
        PrintError("missing-pid-argument", exitCode, exitCode);
        return exitCode;
      }

      uint32_t targetPid = 0;
      try {
        targetPid = static_cast<uint32_t>(std::stoul(argv[2]));
      } catch (const std::exception&) {
        std::cerr << "Invalid PID argument: " << argv[2] << "\n";
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"error\",\n";
        std::cout << "  \"error\": \"invalid-pid-argument\"\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kCaptureTestFailed);
      }

      screenlink::audio::CaptureConfig config;
      config.targetPid = targetPid;
      config.durationMs = 5000;
      config.includeMode = true;

      // Parse optional args from argv[3..]
      for (int i = 3; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--duration-ms" && i + 1 < argc) {
          try {
            config.durationMs = static_cast<uint32_t>(std::stoul(argv[++i]));
          } catch (const std::exception&) {
            std::cerr << "Invalid --duration-ms value: " << argv[i] << "\n";
            int exitCode = static_cast<int>(screenlink::audio::ExitCode::kCaptureTestFailed);
            PrintError("invalid-duration-ms-argument", exitCode, exitCode);
            return exitCode;
          }
        } else if (arg == "--output" && i + 1 < argc) {
          config.outputPath = argv[++i];
        } else if (arg == "--mode" && i + 1 < argc) {
          std::string mode = argv[++i];
          if (mode == "include") {
            config.includeMode = true;
          } else if (mode == "exclude") {
            config.includeMode = false;
          } else {
            std::cerr << "Invalid --mode value: " << mode << " (expected include|exclude)\n";
            int exitCode = static_cast<int>(screenlink::audio::ExitCode::kCaptureTestFailed);
            PrintError("invalid-mode-argument", exitCode, exitCode);
            return exitCode;
          }
        }
      }

      auto result = screenlink::audio::RunCapture(config);

      if (!result.succeeded) {
        int exitCode = static_cast<int>(screenlink::audio::ExitCode::kCaptureTestFailed);
        PrintError(JsonEscape(result.failureReason).c_str(), exitCode, exitCode);
        return exitCode;
      }

      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"status\": \"ok\",\n";
      std::cout << "  \"framesCaptured\": " << result.framesCaptured << ",\n";
      std::cout << "  \"bytesWritten\": " << result.bytesWritten << ",\n";
      std::cout << "  \"outputPath\": \"" << JsonEscape(result.outputPath) << "\"\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
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
