#include "Protocol.h"
#include "WindowsVersion.h"
#include "AudioCapabilities.h"
#include "WindowEnumerator.h"
#include "ProcessResolver.h"
#include "SourceMapper.h"
#include "WavWriter.h"
#include "LoopbackCapture.h"
#include "PipeTransport.h"

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
    std::cerr << "Usage: screenlink-audio-helper.exe --version|--capabilities|--self-test|--enumerate-windows|--enumerate-sources|--resolve-process-tree <pid>|--resolve-source <sourceId>|--capture-test <pid> [--duration-ms <ms>] [--output <path>] [--mode include|exclude] [--creation-time <value>] [--overwrite]\n";
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
      if (screenlink::audio::ParseCommand("--resolve-source") != screenlink::audio::Command::kResolveSource) {
        std::cerr << "FAIL: ParseCommand('--resolve-source') mismatch\n";
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
          // Current process should have a valid creation time
          if (treeResult.processes[0].creationTimeUtc100ns == 0) {
            std::cerr << "FAIL: ResolveProcessTree() current process creation time is 0\n";
            allPassed = false;
          }
          // targetCreationTimeUtc100ns should match the first process
          if (treeResult.targetCreationTimeUtc100ns != treeResult.processes[0].creationTimeUtc100ns) {
            std::cerr << "FAIL: ResolveProcessTree() targetCreationTimeUtc100ns mismatch\n";
            allPassed = false;
          }
          // Application root should be set (current process is not a system process,
          // so it should be its own root)
          if (treeResult.applicationRootPid == 0) {
            std::cerr << "FAIL: ResolveProcessTree() applicationRootPid is 0\n";
            allPassed = false;
          }
          if (treeResult.applicationRootName.empty()) {
            std::cerr << "FAIL: ResolveProcessTree() applicationRootName is empty\n";
            allPassed = false;
          }
        }
      }

      // ── IsSystemProcess test ──
      {
        if (screenlink::audio::IsSystemProcess("explorer.exe") != true) {
          std::cerr << "FAIL: IsSystemProcess('explorer.exe') should be true\n";
          allPassed = false;
        }
        if (screenlink::audio::IsSystemProcess("EXPLORER.EXE") != true) {
          std::cerr << "FAIL: IsSystemProcess('EXPLORER.EXE') should be true (case insensitive)\n";
          allPassed = false;
        }
        if (screenlink::audio::IsSystemProcess("notepad.exe") != false) {
          std::cerr << "FAIL: IsSystemProcess('notepad.exe') should be false\n";
          allPassed = false;
        }
        if (screenlink::audio::IsSystemProcess("") != false) {
          std::cerr << "FAIL: IsSystemProcess('') should be false\n";
          allPassed = false;
        }
      }

      // ── GetProcessCreationTime test ──
      {
        uint64_t ct = screenlink::audio::GetProcessCreationTime(GetCurrentProcessId());
        if (ct == 0) {
          std::cerr << "FAIL: GetProcessCreationTime(current PID) returned 0\n";
          allPassed = false;
        }
        // PID 0 should always fail
        if (screenlink::audio::GetProcessCreationTime(0) != 0) {
          std::cerr << "FAIL: GetProcessCreationTime(0) should return 0\n";
          allPassed = false;
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

      // ── PipeTransport: sizeof(PcmPacketHeader) ──
      {
          // Compile-time check via static_assert in PipeTransport.h.
          // Runtime check as belt-and-suspenders (use a variable to
          // avoid MSVC C4127 "conditional expression is constant").
          const bool headerSizeOk =
              (sizeof(screenlink::audio::PcmPacketHeader) == 68);
          if (!headerSizeOk) {
              std::cerr << "FAIL: sizeof(PcmPacketHeader) is "
                        << sizeof(screenlink::audio::PcmPacketHeader)
                        << " (expected 68)\n";
              allPassed = false;
          }
      }

      // ── PipeTransport: queue push/pop/full/drop/empty ──
      {
          screenlink::audio::PcmPacketQueue queue(5); // usable capacity = 4
          if (queue.MaxSize() != 4) {
              std::cerr << "FAIL: queue.MaxSize() = " << queue.MaxSize()
                        << " (expected 4)\n";
              allPassed = false;
          }

          // Push 4 packets
          for (int i = 0; i < 4; ++i) {
              screenlink::audio::PcmPacket p;
              p.header.sequenceNumber = static_cast<uint64_t>(i);
              if (!queue.TryPush(std::move(p))) {
                  std::cerr << "FAIL: queue.TryPush failed on iteration " << i << "\n";
                  allPassed = false;
              }
          }

          // Queue should now be full (5th push fails)
          screenlink::audio::PcmPacket overflowPacket;
          overflowPacket.header.sequenceNumber = 99;
          if (queue.TryPush(std::move(overflowPacket))) {
              std::cerr << "FAIL: queue.TryPush should have returned false (full)\n";
              allPassed = false;
          }

          // Drop count should be 1
          if (queue.DroppedCount() != 1) {
              std::cerr << "FAIL: queue.DroppedCount() = " << queue.DroppedCount()
                        << " (expected 1)\n";
              allPassed = false;
          }

          // Pop 4 packets
          for (int i = 0; i < 4; ++i) {
              screenlink::audio::PcmPacket p;
              if (!queue.TryPop(p)) {
                  std::cerr << "FAIL: queue.TryPop failed on iteration " << i << "\n";
                  allPassed = false;
              }
          }

          // Queue should now be empty
          screenlink::audio::PcmPacket emptyPacket;
          if (queue.TryPop(emptyPacket)) {
              std::cerr << "FAIL: queue.TryPop should have returned false (empty)\n";
              allPassed = false;
          }

          // Size should be 0
          if (queue.Size() != 0) {
              std::cerr << "FAIL: queue.Size() = " << queue.Size()
                        << " (expected 0 after draining)\n";
              allPassed = false;
          }
      }

      // ── PipeTransport: queue sequence number round-trip ──
      {
          screenlink::audio::PcmPacketQueue queue(4);
          screenlink::audio::PcmPacket in;
          in.header.sequenceNumber = 42;
          in.header.frameCount = 480;
          in.header.channels = 2;
          in.payload.resize(480 * 2, 0.5f);

          if (!queue.TryPush(std::move(in))) {
              std::cerr << "FAIL: queue.TryPush (round-trip) failed\n";
              allPassed = false;
          }

          screenlink::audio::PcmPacket out;
          if (!queue.TryPop(out)) {
              std::cerr << "FAIL: queue.TryPop (round-trip) failed\n";
              allPassed = false;
          }

          if (out.header.sequenceNumber != 42) {
              std::cerr << "FAIL: sequenceNumber round-trip: got "
                        << out.header.sequenceNumber
                        << " (expected 42)\n";
              allPassed = false;
          }

          if (out.header.frameCount != 480) {
              std::cerr << "FAIL: frameCount round-trip: got "
                        << out.header.frameCount
                        << " (expected 480)\n";
              allPassed = false;
          }

          if (out.payload.size() != 960) {
              std::cerr << "FAIL: payload size round-trip: got "
                        << out.payload.size()
                        << " (expected 960)\n";
              allPassed = false;
          }
      }

      // ── PipeTransport: ValidatePcmHeader valid ──
      {
          screenlink::audio::PcmPacketHeader h;
          h.frameCount = 480;
          h.channels = 2;
          h.payloadBytes = 480 * 2 * static_cast<uint32_t>(sizeof(float));
          auto result = screenlink::audio::ValidatePcmHeader(h);
          if (!result.valid) {
              std::cerr << "FAIL: ValidatePcmHeader(valid) failed: "
                        << result.error << "\n";
              allPassed = false;
          }
      }

      // ── PipeTransport: ValidatePcmHeader invalid magic ──
      {
          screenlink::audio::PcmPacketHeader h;
          h.magic = 0xDEADBEEF;
          h.frameCount = 480;
          h.channels = 2;
          h.payloadBytes = 480 * 2 * static_cast<uint32_t>(sizeof(float));
          auto result = screenlink::audio::ValidatePcmHeader(h);
          if (result.valid) {
              std::cerr << "FAIL: ValidatePcmHeader(invalid magic) "
                           "should have failed\n";
              allPassed = false;
          }
      }

      // ── PipeTransport: ValidatePcmHeader overflow payload ──
      {
          screenlink::audio::PcmPacketHeader h;
          h.frameCount = screenlink::audio::kMaxPcmFramesPerPacket;
          h.channels = 2;
          // payloadBytes is valid (matches frameCount * channels * sizeof(float))
          h.payloadBytes = h.frameCount * h.channels * static_cast<uint32_t>(sizeof(float));
          // Now mess up frameCount to trigger overflow detection
          // Actually, the overflow check is for expectedPayload > kMaxPcmFrameBytes
          // which won't trigger with valid values.
          // Instead, set frameCount to something that makes payloadBytes exceed kMaxPcmFrameBytes.
          // But payloadBytes is computed from frameCount, so they'll match.
          // Let's set a valid payloadBytes but make frameCount*channels*sizeof(float) overflow uint32_t
          // No — make frameCount huge so expectedPayload (uint64_t) exceeds kMaxPcmFrameBytes
          h.frameCount = screenlink::audio::kMaxPcmFramesPerPacket + 1;
          h.payloadBytes = (h.frameCount) * h.channels * static_cast<uint32_t>(sizeof(float));
          auto result = screenlink::audio::ValidatePcmHeader(h);
          if (result.valid) {
              std::cerr << "FAIL: ValidatePcmHeader(overflow frames) "
                           "should have failed\n";
              allPassed = false;
          }
      }

      // ── PipeTransport: ValidatePcmHeader mismatched payloadBytes ──
      {
          screenlink::audio::PcmPacketHeader h;
          h.frameCount = 480;
          h.channels = 2;
          h.payloadBytes = 480 * 2 * static_cast<uint32_t>(sizeof(float)) + 1; // off by one
          auto result = screenlink::audio::ValidatePcmHeader(h);
          if (result.valid) {
              std::cerr << "FAIL: ValidatePcmHeader(mismatched payloadBytes) "
                           "should have failed\n";
              allPassed = false;
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
        std::cout << "      \"isCloaked\": " << (w.isCloaked ? "true" : "false") << ",\n";
        std::cout << "      \"processCreationTimeUtc100ns\": " << w.processCreationTimeUtc100ns << "\n";
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
        std::cout << "      \"hasAudio\": " << (s.hasAudio ? "true" : "false") << ",\n";
        std::cout << "      \"processCreationTimeUtc100ns\": " << s.processCreationTimeUtc100ns << "\n";
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
      std::cout << "  \"targetCreationTimeUtc100ns\": " << result.targetCreationTimeUtc100ns << ",\n";
      std::cout << "  \"applicationRootPid\": " << result.applicationRootPid << ",\n";
      std::cout << "  \"applicationRootName\": \"" << JsonEscape(result.applicationRootName) << "\",\n";
      std::cout << "  \"processChainDepth\": " << result.processes.size() << ",\n";
      std::cout << "  \"processes\": [\n";
      for (size_t i = 0; i < result.processes.size(); ++i) {
        const auto& p = result.processes[i];
        std::cout << "    {\n";
        std::cout << "      \"processId\": " << p.processId << ",\n";
        std::cout << "      \"parentProcessId\": " << p.parentProcessId << ",\n";
        std::cout << "      \"processPath\": \"" << JsonEscape(p.processPath) << "\",\n";
        std::cout << "      \"processName\": \"" << JsonEscape(p.processName) << "\",\n";
        std::cout << "      \"creationTimeUtc100ns\": " << p.creationTimeUtc100ns << "\n";
        std::cout << "    }";
        if (i < result.processes.size() - 1) std::cout << ",";
        std::cout << "\n";
      }
      std::cout << "  ]\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
    }

    case screenlink::audio::Command::kResolveSource: {
      if (argc < 3) {
        std::cerr << "Missing source ID argument for --resolve-source\n";
        std::cout << "{\n";
        std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
        std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
        std::cout << "  \"status\": \"error\",\n";
        std::cout << "  \"error\": \"missing-source-id-argument\"\n";
        std::cout << "}\n";
        return static_cast<int>(screenlink::audio::ExitCode::kSourceResolutionFailed);
      }

      std::string sourceId = argv[2];

      auto result = screenlink::audio::ResolveDesktopCapturerSource(sourceId);

      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"status\": \"ok\",\n";
      std::cout << "  \"found\": " << (result.found ? "true" : "false") << ",\n";
      if (result.found) {
        std::cout << "  \"source\": {\n";
        std::cout << "    \"sourceId\": \"" << JsonEscape(result.source.sourceId) << "\",\n";
        std::cout << "    \"displayName\": \"" << JsonEscape(result.source.displayName) << "\",\n";
        std::cout << "    \"processId\": " << result.source.processId << ",\n";
        std::cout << "    \"hwnd\": " << result.source.hwnd << ",\n";
        std::cout << "    \"processPath\": \"" << JsonEscape(result.source.processPath) << "\",\n";
        std::cout << "    \"processName\": \"" << JsonEscape(result.source.processName) << "\",\n";
        std::cout << "    \"isElectron\": " << (result.source.isElectron ? "true" : "false") << ",\n";
        std::cout << "    \"electronConfidence\": " << static_cast<int>(result.source.electronConfidence) << ",\n";
        std::cout << "    \"windowTitle\": \"" << JsonEscape(result.source.windowTitle) << "\",\n";
        std::cout << "    \"windowClass\": \"" << JsonEscape(result.source.windowClass) << "\",\n";
        std::cout << "    \"isVisible\": " << (result.source.isVisible ? "true" : "false") << ",\n";
        std::cout << "    \"isCloaked\": " << (result.source.isCloaked ? "true" : "false") << ",\n";
        std::cout << "    \"hasAudio\": " << (result.source.hasAudio ? "true" : "false") << ",\n";
        std::cout << "    \"processCreationTimeUtc100ns\": " << result.source.processCreationTimeUtc100ns << "\n";
        std::cout << "  }\n";
      } else {
        std::cout << "  \"error\": \"" << JsonEscape(result.error) << "\"\n";
      }
      std::cout << "}\n";
      return result.found
          ? static_cast<int>(screenlink::audio::ExitCode::kSuccess)
          : static_cast<int>(screenlink::audio::ExitCode::kSourceResolutionFailed);
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
        } else if (arg == "--creation-time" && i + 1 < argc) {
          try {
            config.expectedCreationTimeUtc100ns = std::stoull(argv[++i]);
          } catch (const std::exception&) {
            std::cerr << "Invalid --creation-time value: " << argv[i] << "\n";
            int exitCode = static_cast<int>(screenlink::audio::ExitCode::kCaptureTestFailed);
            PrintError("invalid-creation-time-argument", exitCode, exitCode);
            return exitCode;
          }
        } else if (arg == "--overwrite") {
          config.overwrite = true;
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
