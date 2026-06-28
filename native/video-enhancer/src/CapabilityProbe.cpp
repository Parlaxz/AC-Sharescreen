#include "CapabilityProbe.h"

namespace screenlink::video {

CapabilityResult ProbeCapability() {
    CapabilityResult result;
    result.available = false;
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
    // Real VFX capability probe will be implemented here in Phase Q.
    // Requires: NVIDIA Video Effects SDK runtime DLLs loaded,
    // model directory present, effect creation succeeds, load succeeds.
    result.reason = "runtime-missing";
#else
    result.reason = "sdk-not-built";
#endif
    return result;
}

} // namespace screenlink::video
