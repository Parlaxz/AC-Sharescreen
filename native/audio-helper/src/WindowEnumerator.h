#ifndef SCREENLINK_WINDOW_ENUMERATOR_H
#define SCREENLINK_WINDOW_ENUMERATOR_H

#include <cstdint>
#include <string>
#include <vector>

namespace screenlink::audio {

struct WindowInfo {
  uint64_t hwnd = 0;          // Window handle as uint64
  uint32_t processId = 0;     // Process ID owning the window
  std::string processPath;    // Full path to the process executable
  std::string windowTitle;    // Window text/title
  std::string windowClass;    // Window class name
  bool isVisible = false;     // WS_VISIBLE flag set
  bool isCloaked = false;     // DWM cloaked (e.g. virtual desktops, tabs)
};

struct EnumerateResult {
  bool succeeded = false;
  std::vector<WindowInfo> windows;
  std::string failureReason;
};

// Enumerate all top-level windows with process info.
EnumerateResult EnumerateWindows();

} // namespace screenlink::audio

#endif // SCREENLINK_WINDOW_ENUMERATOR_H
