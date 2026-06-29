#include "CapabilityProbe.h"
#include "NvidiaVfxContext.h"

namespace screenlink::video {

CapabilityResult ProbeCapability() {
    CapabilityResult result;
    result.available = false;

    // Always set supported modes/qualities so the application knows
    // what the native helper is designed to handle, even when the
    // NVIDIA runtime is not present on this machine.
    result.supportedModes = "vsr,denoise,deblur,high-bitrate";
    result.supportedQualities = "low,medium,high,ultra";

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
#else
    result.reason = "sdk-not-built";
#endif

    return result;
}

} // namespace screenlink::video
