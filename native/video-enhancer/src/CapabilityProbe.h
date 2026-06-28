#pragma once
#include <string>

namespace screenlink::video {

/// Result of probing for NVIDIA RTX VSR capability.
struct CapabilityResult {
    bool available = false;
    std::string reason = "Not probed";
    std::string adapterName;
    std::string driverVersion;
    std::string sdkVersion;
};

/// Probe the system for NVIDIA RTX VSR capability.
/// Phase 7+ will implement actual NVIDIA VSR runtime probing.
CapabilityResult ProbeCapability();

} // namespace screenlink::video
