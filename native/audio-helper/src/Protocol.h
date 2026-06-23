#ifndef SCREENLINK_AUDIO_PROTOCOL_H
#define SCREENLINK_AUDIO_PROTOCOL_H

#include <cstdint>
#include <string_view>

namespace screenlink::audio {

/// Current protocol version for capability reporting.
/// Bump this when adding, removing, or changing fields in the
/// capability response. Breaking changes = major bump.
inline constexpr std::string_view kProtocolVersion = "0.1.0";

/// Protocol version for the service control protocol (--serve mode).
inline constexpr std::string_view kServiceProtocolVersion = "0.3.0";

/// Helper application version (matches CMake project version).
inline constexpr std::string_view kHelperVersion = "0.1.0";

/// Minimum Windows build required for process-loopback audio at runtime
/// (ActivateAudioInterfaceAsync with PROCESS_LOOPBACK).
/// The process-loopback API was first available in Windows 10 build 20348
/// (Windows Server 2022 / Windows 10 21H2 Server). Windows 11 build 22000
/// (and later Windows 10 22H2) also support it.
///
/// This is the RUNTIME minimum — the OS build the helper runs on must be
/// >= 20348. The compile-time SDK check (kMinSdkBuildForProcessLoopback) is
/// a separate constant that reflects the Windows SDK version used to build.
///
/// Source: Microsoft Docs — "Loopback Recording"
/// https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
inline constexpr uint32_t kMinProcessLoopbackBuild = 20348;

/// Maximum duration for a capture test in milliseconds.
/// Prevents runaway captures that could fill the disk.
inline constexpr uint32_t kMaxCaptureTestDurationMs = 30000;

/// Command exit codes
enum class ExitCode : int {
  kSuccess = 0,
  kUnknownCommand = 1,
  kInternalError = 2,
  kSelfTestFailed = 3,
  kWindowsVersionDetectionFailed = 10,
  kCapabilityDetectionFailed = 11,
  kEnumerationFailed = 20,
  kProcessResolutionFailed = 21,
  kSourceEnumerationFailed = 22,
  kSourceResolutionFailed = 23,
  kCaptureTestFailed = 30,
  kServeFailed = 40,
  kSessionEnumerationFailed = 24,
  kMixerStartFailed = 41,
};

/// Supported CLI commands
enum class Command {
  kVersion,
  kCapabilities,
  kSelfTest,
  kEnumerateWindows,
  kEnumerateSources,
  kResolveProcessTree,
  kCaptureTest,
  kResolveSource,
  kServe,
  kEnumerateAudioSessions,
  kProbeMmdevice,
  kUnknown,
};

/// Parse a CLI argument into a Command.
inline Command ParseCommand(std::string_view arg) {
  if (arg == "--version") return Command::kVersion;
  if (arg == "--capabilities") return Command::kCapabilities;
  if (arg == "--self-test") return Command::kSelfTest;
  if (arg == "--enumerate-windows") return Command::kEnumerateWindows;
  if (arg == "--enumerate-sources") return Command::kEnumerateSources;
  if (arg == "--resolve-process-tree") return Command::kResolveProcessTree;
  if (arg == "--capture-test") return Command::kCaptureTest;
  if (arg == "--resolve-source") return Command::kResolveSource;
  if (arg == "--serve") return Command::kServe;
  if (arg == "--enumerate-audio-sessions") return Command::kEnumerateAudioSessions;
  if (arg == "--probe-mmdevice") return Command::kProbeMmdevice;
  return Command::kUnknown;
}

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_PROTOCOL_H
