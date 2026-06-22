#include "WindowEnumerator.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <string>
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
// Returns empty string on failure.
std::string WideToUtf8(PCWSTR wideStr, int length = -1) {
  if (wideStr == nullptr) return {};

  // If length is -1 (null-terminated), WideCharToMultiByte will include the null.
  // We want the real length, so compute it first.
  int realLength = (length >= 0) ? length : static_cast<int>(wcslen(wideStr));
  if (realLength == 0) return {};

  int needed = WideCharToMultiByte(CP_UTF8, 0, wideStr, realLength, nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return {};

  std::string result(static_cast<size_t>(needed), '\0');
  int written = WideCharToMultiByte(CP_UTF8, 0, wideStr, realLength, &result[0], needed, nullptr, nullptr);
  if (written <= 0) return {};

  return result;
}

// Get process path from PID. Returns empty string on failure.
std::string GetProcessPathForPid(DWORD pid) {
  AutoHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process.IsValid()) return {};

  WCHAR buffer[MAX_PATH + 1] = {};
  DWORD size = MAX_PATH;
  if (!QueryFullProcessImageNameW(process.Get(), 0, buffer, &size)) return {};

  return WideToUtf8(buffer, static_cast<int>(size));
}

// Callback context for EnumWindows.
struct EnumContext {
  std::vector<WindowInfo>* windows;
};

// EnumWindows callback.
BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
  auto* context = reinterpret_cast<EnumContext*>(lParam);
  auto& windows = *context->windows;

  if (hwnd == nullptr) return TRUE; // skip null

  // Basic info
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);

  // Get window text
  WCHAR titleBuffer[1024] = {};
  int titleLen = GetWindowTextW(hwnd, titleBuffer, _countof(titleBuffer));
  std::string title = WideToUtf8(titleBuffer, std::max(titleLen, 0));

  // Get window class
  WCHAR classBuffer[256] = {};
  int classLen = GetClassNameW(hwnd, classBuffer, _countof(classBuffer));
  std::string windowClass = WideToUtf8(classBuffer, std::max(classLen, 0));

  bool isVisible = (IsWindowVisible(hwnd) != FALSE);

  // DwmGetWindowAttribute for cloaked state
  BOOL isCloaked = FALSE;
  bool cloakedChecked = false;
  HRESULT hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &isCloaked, sizeof(isCloaked));
  if (SUCCEEDED(hr)) {
    cloakedChecked = true;
  }

  // Filter: skip windows that are NULL hwnd (already covered),
  // or shell/desktop background windows (Progman, WorkerW) with no title
  // We want windows that are visible OR have a non-empty title OR have processId != 0.
  // But always include if visible or has a title.
  if (!isVisible && title.empty() && pid == 0) {
    return TRUE; // skip noise
  }

  // Get process path
  std::string processPath = GetProcessPathForPid(pid);

  WindowInfo info;
  info.hwnd = reinterpret_cast<uint64_t>(hwnd);
  info.processId = static_cast<uint32_t>(pid);
  info.processPath = std::move(processPath);
  info.windowTitle = std::move(title);
  info.windowClass = std::move(windowClass);
  info.isVisible = isVisible;
  info.isCloaked = cloakedChecked && (isCloaked != FALSE);
  windows.push_back(std::move(info));

  return TRUE; // continue enumeration
}

} // anonymous namespace

EnumerateResult EnumerateWindows() {
  EnumerateResult result;
  std::vector<WindowInfo> windows;

  EnumContext context{&windows};
  BOOL ok = EnumWindows(EnumWindowsProc, reinterpret_cast<LPARAM>(&context));
  if (!ok) {
    result.failureReason = "EnumWindows failed";
    return result;
  }

  result.succeeded = true;
  result.windows = std::move(windows);
  return result;
}

} // namespace screenlink::audio
