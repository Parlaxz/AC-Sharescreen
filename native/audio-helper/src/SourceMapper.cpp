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
    std::string lowerName = source.processName;
    for (auto& c : lowerName) {
      c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }

    if (_stricmp(source.processName.c_str(), "electron.exe") == 0) {
      // Direct match: process name is exactly electron.exe.
      source.isElectron = true;
      source.electronConfidence = ElectronConfidence::kProcessName;
    } else if (ContainsElectronIc(source.processName)) {
      // Weak match: process name contains "electron".
      source.isElectron = true;
      source.electronConfidence = ElectronConfidence::kLow;
    } else if (electronPids.find(source.processId) != electronPids.end()) {
      // This PID is itself an electron.exe process (should have been caught above,
      // but handle edge case where processName might be truncated or different).
      source.isElectron = true;
      source.electronConfidence = ElectronConfidence::kProcessName;
    } else {
      // Check if this process is the parent of an electron.exe process.
      for (auto electronPid : electronPids) {
        auto it = parentMap.find(electronPid);
        if (it != parentMap.end() && it->second == source.processId) {
          source.isElectron = true;
          source.electronConfidence = ElectronConfidence::kProcessName;
          break;
        }
      }
    }

    // hasAudio: visible, non-cloaked Electron apps are likely producing audio.
    source.hasAudio = (source.isElectron && source.isVisible && !source.isCloaked);

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

} // namespace screenlink::audio
