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
};

struct ProcessTreeResult {
  bool succeeded = false;
  uint32_t targetPid = 0;
  std::vector<ProcessInfo> processes;  // Ordered: target, parent, grandparent, ...
  std::string failureReason;
};

// Walk the parent-process chain from the given PID up to the root.
// Returns the chain ordered from target -> parent -> grandparent -> ... -> root.
ProcessTreeResult ResolveProcessTree(uint32_t targetPid);

} // namespace screenlink::audio

#endif // SCREENLINK_PROCESS_RESOLVER_H
