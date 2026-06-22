#include "SourceMapper.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>

#include <cctype>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace screenlink::audio {

namespace {

// ── RAII wrapper for handles that need CloseHandle ──
class AutoHandle {
public:
  explicit AutoHandle(HANDLE h) noexcept : handle_(h) {}
  ~AutoHandle() noexcept { if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_); }
  AutoHandle(const AutoHandle&) = delete;
  AutoHandle& operator=(const AutoHandle&) = delete;
  AutoHandle(AutoHandle&& other) noexcept : handle_(other.handle_) { other.handle_ = nullptr; }
  AutoHandle& operator=(AutoHandle&& other) noexcept {
    if (this != &other) {
      if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
      handle_ = other.handle_;
      other.handle_ = nullptr;
    }
    return *this;
  }
  HANDLE Get() const noexcept { return handle_; }
  bool IsValid() const noexcept { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }

private:
  HANDLE handle_ = nullptr;
};

// ── Wide string to UTF-8 ──
std::string WideToUtf8(PCWSTR wideStr, int length = -1) {
  if (wideStr == nullptr) return {};

  int realLength = (length >= 0) ? length : static_cast<int>(wcslen(wideStr));
  if (realLength == 0) return {};

  int needed = WideCharToMultiByte(CP_UTF8, 0, wideStr, realLength, nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return {};

  std::string result(static_cast<size_t>(needed), '\0');
  int written = WideCharToMultiByte(CP_UTF8, 0, wideStr, realLength, &result[0], needed, nullptr, nullptr);
  if (written <= 0) return {};

  return result;
}

// ── Extract filename from a full path ──
std::string ExtractFilename(const std::string& path) {
  auto pos = path.rfind('\\');
  if (pos == std::string::npos) {
    pos = path.rfind('/');
  }
  if (pos == std::string::npos) return path;
  return path.substr(pos + 1);
}

// ── Build maps from process snapshot ──
// Fills parentMap (PID -> parent PID) and electronPids (set of PIDs with name == "electron.exe").
void BuildProcessMaps(std::unordered_map<uint32_t, uint32_t>& parentMap,
                       std::unordered_set<uint32_t>& electronPids) {
  AutoHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot.IsValid()) return;

  PROCESSENTRY32W pe32 = {};
  pe32.dwSize = sizeof(pe32);

  if (!Process32FirstW(snapshot.Get(), &pe32)) return;

  do {
    parentMap[pe32.th32ProcessID] = pe32.th32ParentProcessID;

    std::string exeName = WideToUtf8(pe32.szExeFile);
    if (_stricmp(exeName.c_str(), "electron.exe") == 0) {
      electronPids.insert(pe32.th32ProcessID);
    }
  } while (Process32NextW(snapshot.Get(), &pe32));
}

// ── Case-insensitive "electron" substring check ──
bool ContainsElectronIc(const std::string& name) {
  std::string lower = name;
  for (auto& c : lower) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return lower.find("electron") != std::string::npos;
}

// ── Electron confidence determination ──
// Returns the confidence level based on process name and parent relationships.
ElectronConfidence DetermineElectronConfidence(
    uint32_t pid,
    const std::string& processName,
    const std::unordered_map<uint32_t, uint32_t>& parentMap,
    const std::unordered_set<uint32_t>& electronPids) {

  if (_stricmp(processName.c_str(), "electron.exe") == 0) {
    return ElectronConfidence::kProcessName;
  }
  if (ContainsElectronIc(processName)) {
    return ElectronConfidence::kLow;
  }
  if (electronPids.find(pid) != electronPids.end()) {
    return ElectronConfidence::kProcessName;
  }
  for (auto electronPid : electronPids) {
    auto it = parentMap.find(electronPid);
    if (it != parentMap.end() && it->second == pid) {
      return ElectronConfidence::kProcessName;
    }
  }
  return ElectronConfidence::kNone;
}

} // anonymous namespace

SourceEnumerateResult EnumerateAudioSources() {
  SourceEnumerateResult result;

  // Step 1: Get the window catalog.
  auto enumResult = EnumerateWindows();
  if (!enumResult.succeeded) {
    result.failureReason = "EnumerateWindows failed: " + enumResult.failureReason;
    return result;
  }

  // Step 2: Build process maps for parent-of-electron detection.
  std::unordered_map<uint32_t, uint32_t> parentMap;
  std::unordered_set<uint32_t> electronPids;
  BuildProcessMaps(parentMap, electronPids);

  // Step 3: For each window, build an AudioSource.
  for (const auto& w : enumResult.windows) {
    AudioSource source;

    // Copy window info.
    source.hwnd = w.hwnd;
    source.processId = w.processId;
    source.processPath = w.processPath;
    source.windowTitle = w.windowTitle;
    source.windowClass = w.windowClass;
    source.isVisible = w.isVisible;
    source.isCloaked = w.isCloaked;

    // Extract process name.
    source.processName = ExtractFilename(w.processPath);

    // Generate source ID.
    source.sourceId = "source:" + std::to_string(source.processId) + ":" + std::to_string(source.hwnd);

    // Electron detection heuristics.
    auto confidence = DetermineElectronConfidence(
        source.processId, source.processName, parentMap, electronPids);
    source.electronConfidence = confidence;
    source.isElectron = (confidence != ElectronConfidence::kNone);

    // hasAudio: visible, non-cloaked windows with a valid PID can produce audio.
    source.hasAudio = (source.isVisible && !source.isCloaked && source.processId != 0);

    // processCreationTimeUtc100ns from WindowInfo (populated by parallel task)
    source.processCreationTimeUtc100ns = w.processCreationTimeUtc100ns;

    // displayName: use window title if non-empty, otherwise process name.
    if (!source.windowTitle.empty()) {
      source.displayName = source.windowTitle;
    } else {
      source.displayName = source.processName;
    }

    result.sources.push_back(std::move(source));
  }

  result.succeeded = true;
  return result;
}

SourceResolveResult ResolveDesktopCapturerSource(const std::string& sourceId) {
  SourceResolveResult result;

  // Parse source ID format: "window:0xHEXHWND" or "window:DECIMALHWND"
  if (sourceId.size() < 7 || sourceId.substr(0, 7) != "window:") {
    result.error = "Unsupported source ID format (expected 'window:...')";
    return result;
  }

  std::string hwndStr = sourceId.substr(7);

  uint64_t hwnd = 0;
  try {
    if (hwndStr.size() >= 2 && hwndStr[0] == '0' &&
        (hwndStr[1] == 'x' || hwndStr[1] == 'X')) {
      hwnd = std::stoull(hwndStr, nullptr, 16);
    } else {
      hwnd = std::stoull(hwndStr, nullptr, 10);
    }
  } catch (const std::exception&) {
    result.error = "Invalid HWND in source ID";
    return result;
  }

  if (hwnd == 0) {
    result.error = "HWND is zero in source ID";
    return result;
  }

  // Enumerate windows and find matching HWND
  auto enumResult = EnumerateWindows();
  if (!enumResult.succeeded) {
    result.error = "EnumerateWindows failed: " + enumResult.failureReason;
    return result;
  }

  const WindowInfo* match = nullptr;
  for (const auto& w : enumResult.windows) {
    if (w.hwnd == hwnd) {
      match = &w;
      break;
    }
  }

  if (!match) {
    result.error = "No window found with HWND " + hwndStr;
    return result;
  }

  // Build AudioSource from WindowInfo
  result.source.hwnd = match->hwnd;
  result.source.processId = match->processId;
  result.source.processPath = match->processPath;
  result.source.windowTitle = match->windowTitle;
  result.source.windowClass = match->windowClass;
  result.source.isVisible = match->isVisible;
  result.source.isCloaked = match->isCloaked;
  result.source.processName = ExtractFilename(match->processPath);

  // Source ID
  result.source.sourceId = "source:" + std::to_string(result.source.processId) +
                           ":" + std::to_string(result.source.hwnd);

  // hasAudio based on visibility (not Electron)
  result.source.hasAudio =
      match->isVisible && !match->isCloaked && match->processId != 0;

  // processCreationTimeUtc100ns from WindowInfo (added by parallel task)
  result.source.processCreationTimeUtc100ns = match->processCreationTimeUtc100ns;

  // Determine Electron confidence
  {
    std::unordered_map<uint32_t, uint32_t> parentMap;
    std::unordered_set<uint32_t> electronPids;
    BuildProcessMaps(parentMap, electronPids);

    auto confidence = DetermineElectronConfidence(
        result.source.processId, result.source.processName,
        parentMap, electronPids);
    result.source.electronConfidence = confidence;
    result.source.isElectron = (confidence != ElectronConfidence::kNone);
  }

  // displayName
  if (!result.source.windowTitle.empty()) {
    result.source.displayName = result.source.windowTitle;
  } else {
    result.source.displayName = result.source.processName;
  }

  result.found = true;
  return result;
}

} // namespace screenlink::audio
