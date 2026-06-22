#include "ProcessResolver.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <algorithm>
#include <string>
#include <unordered_map>
#include <vector>

namespace screenlink::audio {

namespace {

// RAII wrapper for handles that need CloseHandle.
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

// Convert a wide string to UTF-8.
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

// Get process path from PID via OpenProcess + QueryFullProcessImageNameW.
std::string GetProcessPathForPid(DWORD pid) {
  AutoHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process.IsValid()) return {};

  WCHAR buffer[MAX_PATH + 1] = {};
  DWORD size = MAX_PATH;
  if (!QueryFullProcessImageNameW(process.Get(), 0, buffer, &size)) return {};

  return WideToUtf8(buffer, static_cast<int>(size));
}

// Extract filename from a full path.
std::string ExtractFilename(const std::string& path) {
  auto pos = path.rfind('\\');
  if (pos == std::string::npos) {
    pos = path.rfind('/');
  }
  if (pos == std::string::npos) return path;
  return path.substr(pos + 1);
}

} // anonymous namespace

ProcessTreeResult ResolveProcessTree(uint32_t targetPid) {
  ProcessTreeResult result;
  result.targetPid = targetPid;

  // Take a snapshot of all processes.
  AutoHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot.IsValid()) {
    result.failureReason = "CreateToolhelp32Snapshot failed";
    return result;
  }

  // Build a PID -> parent PID map.
  std::unordered_map<uint32_t, uint32_t> parentMap;

  PROCESSENTRY32W pe32 = {};
  pe32.dwSize = sizeof(pe32);

  if (!Process32FirstW(snapshot.Get(), &pe32)) {
    result.failureReason = "Process32FirstW failed";
    return result;
  }

  do {
    parentMap[pe32.th32ProcessID] = pe32.th32ParentProcessID;
  } while (Process32NextW(snapshot.Get(), &pe32));

  // Walk the chain from targetPid up to root (pid=0).
  std::vector<uint32_t> pidChain;
  uint32_t currentPid = targetPid;

  // Limit chain length to prevent infinite loops.
  constexpr uint32_t kMaxChainLength = 256;
  uint32_t steps = 0;

  while (currentPid != 0 && steps < kMaxChainLength) {
    pidChain.push_back(currentPid);

    auto it = parentMap.find(currentPid);
    if (it == parentMap.end()) {
      break; // no parent info found
    }
    currentPid = it->second;
    ++steps;
  }

  // Build ProcessInfo for each PID in the chain.
  for (auto pid : pidChain) {
    ProcessInfo info;
    info.processId = pid;

    // Look up parent PID.
    auto it = parentMap.find(pid);
    if (it != parentMap.end()) {
      info.parentProcessId = it->second;
    }

    // Get executable path.
    std::string path = GetProcessPathForPid(pid);
    info.processPath = path;
    info.processName = ExtractFilename(path);

    result.processes.push_back(std::move(info));
  }

  result.succeeded = true;
  return result;
}

} // namespace screenlink::audio
