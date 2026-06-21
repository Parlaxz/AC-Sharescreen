#include "WindowsVersion.h"

#define WIN32_NO_STATUS
#include <windows.h>
#undef WIN32_NO_STATUS
#include <ntstatus.h>

namespace screenlink::audio {

WindowsVersionResult DetectWindowsVersion() {
  WindowsVersionResult result;

  auto* ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) {
    result.detectionMethod = "failed";
    result.failureReason = "GetModuleHandleW(ntdll.dll) failed";
    return result;
  }

  using RtlGetVersionPtr = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  auto* rtlGetVersion = reinterpret_cast<RtlGetVersionPtr>(
      GetProcAddress(ntdll, "RtlGetVersion"));

  if (!rtlGetVersion) {
    result.detectionMethod = "failed";
    result.failureReason = "GetProcAddress(RtlGetVersion) failed";
    return result;
  }

  RTL_OSVERSIONINFOW osvi = {};
  osvi.dwOSVersionInfoSize = sizeof(osvi);
  LONG status = rtlGetVersion(&osvi);

  if (status != STATUS_SUCCESS) {
    result.detectionMethod = "failed";
    result.failureReason = "RtlGetVersion returned status: " + std::to_string(status);
    return result;
  }

  result.major = static_cast<uint32_t>(osvi.dwMajorVersion);
  result.minor = static_cast<uint32_t>(osvi.dwMinorVersion);
  result.build = static_cast<uint32_t>(osvi.dwBuildNumber);
  // RTL_OSVERSIONINFOW does not provide revision field; revision stays 0.
  result.succeeded = true;
  result.detectionMethod = "RtlGetVersion";

  return result;
}

} // namespace screenlink::audio
