#ifndef SCREENLINK_SOURCE_MAPPER_H
#define SCREENLINK_SOURCE_MAPPER_H

#include "WindowEnumerator.h"
#include <string>
#include <vector>

namespace screenlink::audio {

/// Detection result for whether a process is Electron-based.
enum class ElectronConfidence {
  kNone,        // Not an Electron process
  kProcessName, // Process name matches electron.exe or similar
  kLow,         // Weak evidence (e.g., contains "electron" in path)
};

/// Extended source info for audio capture targeting.
struct AudioSource {
  // Source identity
  std::string sourceId;        // Unique ID: "source:{processId}:{hwnd}"
  std::string displayName;     // Human-readable name (window title or process name)

  // Process info (from WindowInfo)
  uint32_t processId = 0;
  uint64_t hwnd = 0;
  std::string processPath;
  std::string processName;     // Just the executable filename
  bool isElectron = false;     // True if Electron app detected
  ElectronConfidence electronConfidence = ElectronConfidence::kNone;

  // Window info
  std::string windowTitle;
  std::string windowClass;
  bool isVisible = false;
  bool isCloaked = false;
  bool hasAudio = false;       // Visible, non-cloaked windows with valid PID
  uint64_t processCreationTimeUtc100ns = 0;
};

struct SourceEnumerateResult {
  bool succeeded = false;
  std::vector<AudioSource> sources;
  std::string failureReason;
};

/// Enumerate all audio-capture sources by combining window enumeration
/// with Electron detection heuristics.
SourceEnumerateResult EnumerateAudioSources();

/// Result of resolving a desktopCapturer source ID.
struct SourceResolveResult {
  bool found = false;
  AudioSource source;
  std::string error;
};

/// Resolve a desktopCapturer source ID (e.g., "window:0x1234") to an AudioSource.
SourceResolveResult ResolveDesktopCapturerSource(const std::string& sourceId);

} // namespace screenlink::audio

#endif // SCREENLINK_SOURCE_MAPPER_H
