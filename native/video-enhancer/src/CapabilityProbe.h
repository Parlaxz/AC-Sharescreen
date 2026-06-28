#pragma once
#include <string>

namespace screenlink::video {

struct CapabilityResult {
    bool available = false;
    std::string reason;
    std::string adapterName;
    std::string driverVersion;
    std::string supportedModes;
    std::string supportedQualities;
};

/// Probe NVIDIA RTX VSR capability.
/// Returns available=false with reason="sdk-not-built" unless
/// SCREENLINK_NVIDIA_VFX_ENABLED is defined and the real VFX pipeline succeeds.
CapabilityResult ProbeCapability();

} // namespace screenlink::video
