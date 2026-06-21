#ifndef SCREENLINK_AUDIO_PROTOCOL_H
#define SCREENLINK_AUDIO_PROTOCOL_H

#include <cstdint>
#include <string>
#include <string_view>

namespace screenlink::audio {

/// Current protocol version for capability reporting.
/// Bump this when adding, removing, or changing fields in the
/// capability response. Breaking changes = major bump.
inline constexpr std::string_view kProtocolVersion = "0.1.0";

/// Helper application version (matches CMake project version).
inline constexpr std::string_view kHelperVersion = "0.1.0";

/// Minimum Windows build required for process-loopback audio
/// (ActivateAudioInterfaceAsync with PROCESS_LOOPBACK).
/// Source: Microsoft Docs — "Loopback Recording" requires Windows 10
/// build 22000 or later (Windows 11 / Windows 10 21H2+).
/// https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
inline constexpr uint32_t kMinProcessLoopbackBuild = 22000;

/// Command exit codes
enum class ExitCode : int {
  kSuccess = 0,
  kUnknownCommand = 1,
  kInternalError = 2,
  kSelfTestFailed = 3,
  kWindowsVersionDetectionFailed = 10,
  kCapabilityDetectionFailed = 11,
};

/// Supported CLI commands
enum class Command {
  kVersion,
  kCapabilities,
  kSelfTest,
  kUnknown,
};

/// Parse a CLI argument into a Command.
inline Command ParseCommand(std::string_view arg) {
  if (arg == "--version") return Command::kVersion;
  if (arg == "--capabilities") return Command::kCapabilities;
  if (arg == "--self-test") return Command::kSelfTest;
  return Command::kUnknown;
}

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_PROTOCOL_H
