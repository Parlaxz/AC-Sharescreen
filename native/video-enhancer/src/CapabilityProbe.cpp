#include "CapabilityProbe.h"

namespace screenlink::video {

CapabilityResult ProbeCapability() {
    CapabilityResult result;
    result.available = false;
    result.reason = "NVIDIA VSR probing requires Phase 7+ native implementation";
    return result;
}

} // namespace screenlink::video
