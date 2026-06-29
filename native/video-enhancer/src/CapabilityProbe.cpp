#include "CapabilityProbe.h"
#include "NvidiaVfxContext.h"

namespace screenlink::video {

CapabilityResult ProbeCapability() {
    CapabilityResult result;
    result.available = false;

#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
    NvidiaVfxContext context;
    NvVfxConfig config;

    NvVfxResult status = context.Initialize(config);
    if (status != NvVfxResult::kSuccess) {
        result.reason = context.GetLastError();
        return result;
    }

    status = context.CreateEffect();
    if (status != NvVfxResult::kSuccess) {
        result.reason = context.GetLastError();
        return result;
    }

    result.available = true;
    result.reason = "available";
    result.supportedModes = "nvidia-vsr";
    result.supportedQualities = "0,1,2,3,4";
#else
    result.reason = "sdk-not-built";
#endif

    return result;
}

} // namespace screenlink::video
