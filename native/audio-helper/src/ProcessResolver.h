#ifndef SCREENLINK_PROCESS_RESOLVER_H
#define SCREENLINK_PROCESS_RESOLVER_H

#include <cstdint>
#include <string>
#include <vector>

namespace screenlink::audio {

struct ProcessInfo {
  uint32_t processId = 0;
  uint32_t parentProcessId = 0;
  std::string processPath;    // Full executable path
  std::string processName;    // Just the executable filename
  uint64_t creationTimeUtc100ns = 0;  // Process creation time in 100ns UTC ticks
};

struct ProcessTreeResult {
  bool succeeded = false;
  uint32_t targetPid = 0;
  uint64_t targetCreationTimeUtc100ns = 0;  // Creation time of target process
  uint32_t applicationRootPid = 0;          // PID of the application root process
  uint64_t applicationRootCreationTimeUtc100ns = 0;  // Creation time of application root
  std::string applicationRootName;          // Name of the application root process
  std::string applicationRootPath;          // Full path of the application root process
  bool usedBasenameFallback = false;        // True if basename fallback was used for root selection
  std::vector<ProcessInfo> processes;  // Ordered: target, parent, grandparent, ...
  std::string failureReason;
};

// Walk the parent-process chain from the given PID up to the root.
// Returns the chain ordered from target -> parent -> grandparent -> ... -> root.
ProcessTreeResult ResolveProcessTree(uint32_t targetPid);

// Get creation time of a process in 100ns UTC ticks. Returns 0 on failure.
uint64_t GetProcessCreationTime(uint32_t pid);

// Get the executable filename for a PID. Returns empty string on failure.
// Uses OpenProcess + GetModuleBaseNameA or falls back to path extraction.
std::string GetProcessName(uint32_t pid);

// Check if a process name is a known system/shell process that should not be
// considered an application root (e.g., explorer.exe, dwm.exe, csrss.exe, etc.)
bool IsSystemProcess(const std::string& processName);

/// Pure function: find the authoritative application root within a pre-resolved
/// process chain. Does not query the OS. Returns the index into `processes`
/// that is the application root. Returns 0 (the session process itself) when no
/// higher ancestor qualifies. Processes must be ordered [target, parent, ...].
/// The session process is at index 0.
///
/// This function contains the same root-selection logic as ResolveProcessTree
/// and is extracted for deterministic testing.
///
/// @param processes  Process chain ordered target -> parent -> grandparent -> ...
/// @param[out] usedBasenameFallback  Set to true if basename fallback was needed
/// @return Index into processes of the application root (0 = session process)
uint32_t FindApplicationRootIndex(
    const std::vector<ProcessInfo>& processes,
    bool& usedBasenameFallback);

} // namespace screenlink::audio

#endif // SCREENLINK_PROCESS_RESOLVER_H
