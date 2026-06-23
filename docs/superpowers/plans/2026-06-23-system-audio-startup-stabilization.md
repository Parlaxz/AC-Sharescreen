# System Audio Startup Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the System Audio capture pipeline so that endpoint loopback produces a live audio track published to VDO.Ninja, matching the proven 440 Hz Test Tone path's reliability.

**Architecture:** The fix addresses 9 defects across 3 layers: (1) native C++ — endpoint readiness handshake, mixer/state race, format conversion contract, cleanup ordering; (2) TypeScript main process — AudioHelperManager lifecycle parity with synthetic path; (3) TypeScript renderer — Dashboard UI state reset, diagnostic counters. The core insight is that the mixer emits its first 10ms block before ServiceSession reaches `kCapturing`, causing OnCapturePacket to reject it, which permanently kills the mixer. The endpoint source also reports success before WASAPI initializes, so failures are invisible.

**Tech Stack:** C++20 (WASAPI, COM), TypeScript, Electron, React

---

## File Structure

| File | Responsibility |
|------|---------------|
| `native/audio-helper/src/EndpointLoopbackSource.h` | Endpoint source header — add readiness signal types, `StartResult`, `EndpointReadyEvent` |
| `native/audio-helper/src/EndpointLoopbackSource.cpp` | Endpoint source impl — bounded readiness handshake, format contract fix, cleanup ordering |
| `native/audio-helper/src/ServiceSession.h` | Session header — add endpoint readiness fields, per-boundary counters |
| `native/audio-helper/src/ServiceSession.cpp` | Session impl — reorder HandleStartEndpointLoopback, add PCM check, wait for endpoint ready, set capturing before mixer start, rollback, diagnostics |
| `native/audio-helper/src/MultiSourceMixer.h` | Mixer header — no changes needed (mixer already has StartResult) |
| `native/audio-helper/src/MultiSourceMixer.cpp` | Mixer impl — no changes needed (mixer behavior is correct once called in right order) |
| `apps/desktop/src/main/AudioHelperManager.ts` | Manager — mirror synthetic lifecycle in startEndpointLoopback |
| `apps/desktop/src/main/ControlClient.ts` | Control client — update startEndpointLoopback return type for readiness fields |
| `apps/desktop/src/renderer/routes/Dashboard.tsx` | Dashboard — move audioTracks log, reset appliedAudioMode on catch |

---

### Task 1: Add endpoint readiness handshake to EndpointLoopbackSource

**Files:**
- Modify: `native/audio-helper/src/EndpointLoopbackSource.h`
- Modify: `native/audio-helper/src/EndpointLoopbackSource.cpp`

This is the foundational fix. The capture thread must report whether WASAPI initialization succeeded before `Start()` returns.

- [ ] **Step 1: Define readiness types in EndpointLoopbackSource.h**

Add before the class definition:

```cpp
/// Result of the endpoint startup handshake.
enum class EndpointStartResult {
    Success,                // WASAPI fully initialized and capturing
    ComInitFailed,          // CoInitializeEx failed
    EnumeratorFailed,       // MMDeviceEnumerator creation failed
    EndpointNotFound,       // No default render endpoint
    AudioClientActivationFailed, // IAudioClient::Activate failed
    GetMixFormatFailed,     // GetMixFormat failed
    InitializeFailed,       // IAudioClient::Initialize failed
    CaptureClientFailed,    // GetService(IAudioCaptureClient) failed
    AudioEngineStartFailed, // IAudioClient::Start failed
    Cancelled,              // Stop() called during startup
};
```

Change `Start()` signature to return a structured result:

```cpp
struct EndpointStartOutcome {
    EndpointStartResult result = EndpointStartResult::Success;
    HRESULT hr = S_OK;  // relevant HRESULT for diagnostics
};

/// Start capturing. Blocks until WASAPI initialization completes or fails.
/// @param onPacket  Callback for captured AudioPackets
/// @return Outcome with success/failure and HRESULT
EndpointStartOutcome Start(std::function<bool(const AudioPacket&)> onPacket);
```

Add private members for the readiness handshake:

```cpp
// Readiness handshake
std::mutex startupMutex_;
std::condition_variable startupCv_;
EndpointStartOutcome startupOutcome_;
bool startupComplete_ = false;
```

- [ ] **Step 2: Rewrite Start() to block until WASAPI reports ready**

Replace the current `Start()` implementation. The thread is still created, but `Start()` now waits on the condition variable until the capture thread signals readiness or failure:

```cpp
EndpointStartOutcome EndpointLoopbackSource::Start(
    std::function<bool(const AudioPacket&)> onPacket)
{
    if (running_.load()) {
        EndpointStartOutcome out;
        out.result = EndpointStartResult::ComInitFailed; // already running
        return out;
    }

    // Reset startup state
    {
        std::lock_guard<std::mutex> lock(startupMutex_);
        startupComplete_ = false;
        startupOutcome_ = {};
    }

    running_.store(true);

    try {
        captureThread_ = std::thread(&EndpointLoopbackSource::CaptureThread,
                                      this, std::move(onPacket));
    } catch (const std::exception&) {
        running_.store(false);
        EndpointStartOutcome out;
        out.result = EndpointStartResult::ComInitFailed;
        return out;
    }

    // Wait for the capture thread to report readiness (bounded)
    EndpointStartOutcome out;
    {
        std::unique_lock<std::mutex> lock(startupMutex_);
        if (!startupCv_.wait_for(lock, std::chrono::seconds(5),
                [this] { return startupComplete_.load(); }))
        {
            // Timeout — WASAPI init took too long
            running_.store(false);
            if (captureThread_.joinable()) captureThread_.join();
            out.result = EndpointStartResult::InitializeFailed;
            out.hr = E_TIMEOUT;
            return out;
        }
        out = startupOutcome_;
    }

    if (out.result != EndpointStartResult::Success) {
        // WASAPI init failed — join the thread (it's already exiting)
        if (captureThread_.joinable()) captureThread_.join();
    }

    return out;
}
```

- [ ] **Step 3: Add SignalStartupComplete helper and modify CaptureThread to signal readiness**

Add a private helper:

```cpp
void EndpointLoopbackSource::SignalStartupComplete(EndpointStartResult result, HRESULT hr) {
    std::lock_guard<std::mutex> lock(startupMutex_);
    startupOutcome_.result = result;
    startupOutcome_.hr = hr;
    startupComplete_ = true;
    startupCv_.notify_one();
}
```

In `CaptureThread`, after each early-return failure point, replace `running_.store(false); return;` with:

```cpp
SignalStartupComplete(EndpointStartResult::ComInitFailed, hr);
running_.store(false);
return;
```

Use the appropriate `EndpointStartResult` enum value for each failure point:
- After CoInitializeEx → `ComInitFailed`
- After CoCreateInstance → `EnumeratorFailed`
- After GetDefaultAudioEndpoint → `EndpointNotFound`
- After Activate(IAudioClient) → `AudioClientActivationFailed`
- After GetMixFormat → `GetMixFormatFailed`
- After Initialize → `InitializeFailed`
- After GetService(IAudioCaptureClient) → `CaptureClientFailed`
- After IAudioClient::Start → `AudioEngineStartFailed`

After the successful `pAudioClient->Start()` call (line ~542 in current code), add:

```cpp
// Signal readiness to the caller
SignalStartupComplete(EndpointStartResult::Success, S_OK);
```

Also check `running_` at each step — if Stop() was called during startup, signal `Cancelled`:

```cpp
if (!running_.load()) {
    SignalStartupComplete(EndpointStartResult::Cancelled, S_OK);
    // cleanup already-done resources...
    return;
}
```

- [ ] **Step 4: Assign audioClient_ member in CaptureThread**

The current code uses a local `pAudioClient` but never assigns it to `audioClient_`, so `Stop()` cannot call `audioClient_->Stop()`. After the successful `pAudioClient->Start()` call and before the capture loop, add:

```cpp
audioClient_ = pAudioClient;
```

At the end of CaptureThread (cleanup section), add:

```cpp
audioClient_ = nullptr;
```

- [ ] **Step 5: Fix destructor ordering**

Current code deletes `resampler_` before calling `Stop()`. Fix:

```cpp
EndpointLoopbackSource::~EndpointLoopbackSource() {
    Stop();
    delete resampler_;
    resampler_ = nullptr;
}
```

- [ ] **Step 6: Build and verify compilation**

Run: `cd native\audio-helper && cmake --build build --config Release 2>&1 | Select-Object -Last 20`
Expected: Build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add native/audio-helper/src/EndpointLoopbackSource.h native/audio-helper/src/EndpointLoopbackSource.cpp
git commit -m "fix(audio): add bounded WASAPI readiness handshake to EndpointLoopbackSource

Start() now blocks until the capture thread reports WASAPI init success or
failure, returning a structured EndpointStartOutcome. Also fixes audioClient_
ownership (was never assigned from local) and destructor ordering (resampler
deleted before Stop)."
```

---

### Task 2: Fix format conversion contract in EndpointLoopbackSource

**Files:**
- Modify: `native/audio-helper/src/EndpointLoopbackSource.cpp`

With `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, WASAPI delivers data in the target format (48kHz stereo float32). The current code conditionally reinterprets the buffer using the original mix format, which is contradictory.

- [ ] **Step 1: Simplify the capture loop format handling**

In `CaptureThread`, after the capture loop starts (the `while (running_.load())` block), replace the entire format-conversion block (lines ~644-773 in current code) with a single contract: data is always in target format.

Replace the `if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { ... } else if (srcFmt matches target) { ... } else { ... }` block with:

```cpp
            // With AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, WASAPI delivers
            // data in our target format (48kHz stereo float32).
            // Always interpret the buffer as target format.

            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                // Zero-fill silent frames to preserve timeline
                size_t totalSamples =
                    static_cast<size_t>(numFramesAvailable) * kTargetChannels;
                conversionBuffer_.assign(totalSamples, 0.0f);
                packet.frames = conversionBuffer_.data();
                packet.isSilent = true;
            } else {
                // Data is in target format — reference directly
                packet.frames = reinterpret_cast<const float*>(pData);
            }
            packet.channels = kTargetChannels;
```

Remove the `srcFmt`-based conditional branches (the `else` block that does manual downmix/resample). The `srcFmt` variable and `ChannelDownmixer` class can remain in the file for potential future use, but the capture loop no longer uses them.

- [ ] **Step 2: Build and verify compilation**

Run: `cd native\audio-helper && cmake --build build --config Release 2>&1 | Select-Object -Last 20`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add native/audio-helper/src/EndpointLoopbackSource.cpp
git commit -m "fix(audio): use single format contract with AUTOCONVERTPCM

With AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, WASAPI delivers data in the
requested target format. Remove the contradictory conditional that
reinterpreted the buffer using the original mix format, which could
produce garbage or silence when the endpoint mix format differed from
48kHz stereo float32."
```

---

### Task 3: Fix the mixer/state race in HandleStartEndpointLoopback

**Files:**
- Modify: `native/audio-helper/src/ServiceSession.cpp`
- Modify: `native/audio-helper/src/ServiceSession.h`

This is the primary cause of the missing audio track. The mixer must not start until the session is in `kCapturing`, and the endpoint must report readiness before the handler returns success.

- [ ] **Step 1: Add per-boundary diagnostic counters to ServiceSession.h**

Add after the existing pipeline counters (around line 137):

```cpp
    // Per-boundary endpoint/mixer diagnostics
    std::atomic<uint64_t> endpointPacketsCaptured_{0};
    std::atomic<uint64_t> endpointNonZeroPackets_{0};
    std::atomic<uint64_t> endpointSilentPackets_{0};
    std::atomic<uint64_t> mixerFeedPackets_{0};
    std::atomic<uint64_t> mixerOutputPackets_{0};
    std::atomic<uint64_t> mixerNonZeroOutputPackets_{0};
    std::atomic<uint64_t> onCaptureAccepted_{0};
    std::atomic<uint64_t> onCaptureRejectedState_{0};
```

- [ ] **Step 2: Rewrite HandleStartEndpointLoopback with correct ordering**

The correct startup order is:
1. Verify PCM client connected
2. Create mixer and register source
3. Start endpoint thread (blocks until WASAPI ready)
4. Set state = kCapturing
5. Start mixer
6. Verify mixer still running
7. Return success

On any failure, rollback all resources and return a structured failure.

Replace the entire `HandleStartEndpointLoopback` implementation with:

```cpp
void ServiceSession::HandleStartEndpointLoopback(const std::string& /*payload*/,
                                                  std::string& response) {
    // 1. Check we're not already capturing
    if (state_.load() != static_cast<SessionState>(0)) { // kIdle
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", StateToStr(static_cast<int>(state_.load())));
        resp.Set("error", "already-capturing");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    state_.store(static_cast<SessionState>(1)); // kStarting
    uint32_t gen = streamGeneration_.fetch_add(1) + 1;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        activeSourceType_ = "endpoint-loopback";
    }

    // 2. Wait for PCM pipe client to be connected (parity with synthetic)
    {
        int waitCount = 0;
        while (!pcmWriter_.IsClientConnected() && waitCount < 100) {
            Sleep(10);
            waitCount++;
        }
        if (!pcmWriter_.IsClientConnected()) {
            // Rollback
            state_.store(static_cast<SessionState>(0)); // kIdle
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                activeSourceType_ = "";
            }
            streamGeneration_.fetch_sub(1);
            SimpleJson resp;
            resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
            resp.Set("requestId", static_cast<uint64_t>(0));
            resp.Set("sessionId", config_.sessionId);
            resp.Set("success", false);
            resp.Set("state", "idle");
            resp.Set("error", "pcm-not-connected");
            resp.SetRaw("result", "{}");
            response = resp.Str();
            return;
        }
    }

    // 3. Create mixer and register source
    if (!mixer_) {
        mixer_ = std::make_unique<MultiSourceMixer>(48000, static_cast<uint16_t>(2));
    }
    uint32_t sourceId = mixer_->AddSource(0, 0);

    // 4. Start endpoint source (blocks until WASAPI reports ready)
    endpointSource_ = std::make_unique<EndpointLoopbackSource>();
    auto endpointOutcome = endpointSource_->Start(
        [this, sourceId](const AudioPacket& p) -> bool {
            endpointPacketsCaptured_.fetch_add(1, std::memory_order_relaxed);
            if (p.isSilent) {
                endpointSilentPackets_.fetch_add(1, std::memory_order_relaxed);
            } else {
                // Check for non-zero data
                bool nonZero = false;
                if (p.frames && p.frameCount > 0) {
                    size_t samples = static_cast<size_t>(p.frameCount) * p.channels;
                    for (size_t i = 0; i < samples && i < 10; ++i) {
                        if (p.frames[i] != 0.0f) { nonZero = true; break; }
                    }
                }
                if (nonZero) {
                    endpointNonZeroPackets_.fetch_add(1, std::memory_order_relaxed);
                }
            }
            mixerFeedPackets_.fetch_add(1, std::memory_order_relaxed);
            mixer_->FeedPacket(sourceId, p);
            return true;
        });

    if (endpointOutcome.result != EndpointStartResult::Success) {
        // WASAPI init failed — rollback
        endpointSource_.reset();
        mixer_->RemoveSource(sourceId);
        state_.store(static_cast<SessionState>(0)); // kIdle
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            activeSourceType_ = "";
        }
        streamGeneration_.fetch_sub(1);

        // Map endpoint result to error string
        const char* errorCode = "endpoint-init-failed";
        switch (endpointOutcome.result) {
            case EndpointStartResult::ComInitFailed:
                errorCode = "endpoint-com-init-failed"; break;
            case EndpointStartResult::EnumeratorFailed:
                errorCode = "endpoint-enumerator-failed"; break;
            case EndpointStartResult::EndpointNotFound:
                errorCode = "endpoint-not-found"; break;
            case EndpointStartResult::AudioClientActivationFailed:
                errorCode = "endpoint-audio-client-failed"; break;
            case EndpointStartResult::GetMixFormatFailed:
                errorCode = "endpoint-mix-format-failed"; break;
            case EndpointStartResult::InitializeFailed:
                errorCode = "endpoint-initialize-failed"; break;
            case EndpointStartResult::CaptureClientFailed:
                errorCode = "endpoint-capture-client-failed"; break;
            case EndpointStartResult::AudioEngineStartFailed:
                errorCode = "endpoint-engine-start-failed"; break;
            case EndpointStartResult::Cancelled:
                errorCode = "endpoint-cancelled"; break;
            default: break;
        }

        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", errorCode);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // 5. Set state to kCapturing BEFORE starting the mixer
    //    This prevents the race where the mixer's first OnCapturePacket
    //    call returns false because state is still kStarting.
    state_.store(static_cast<SessionState>(2)); // kCapturing

    // 6. Start the mixer (now safe because state == kCapturing)
    auto mixResult = mixer_->Start([this](const AudioPacket& p) -> bool {
        return OnCapturePacket(p);
    });

    if (!mixResult.success) {
        // Mixer failed — rollback everything
        endpointSource_->Stop();
        endpointSource_.reset();
        mixer_->RemoveSource(sourceId);
        state_.store(static_cast<SessionState>(0)); // kIdle
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            activeSourceType_ = "";
        }
        streamGeneration_.fetch_sub(1);

        const char* errorCode = "mixer-start-failed";
        switch (mixResult.error) {
            case MultiSourceMixer::StartError::AlreadyRunning:
                errorCode = "mixer-already-running"; break;
            case MultiSourceMixer::StartError::NoOutputCallback:
                errorCode = "mixer-no-output-callback"; break;
            case MultiSourceMixer::StartError::ThreadCreationFailed:
                errorCode = "mixer-thread-creation-failed"; break;
            case MultiSourceMixer::StartError::StaleThreadNotJoined:
                errorCode = "mixer-stale-thread"; break;
            default: break;
        }
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", errorCode);
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // 7. Verify mixer is still running (it could have stopped if OnCapturePacket
    //    returned false for some other reason)
    if (!mixer_->IsRunning()) {
        endpointSource_->Stop();
        endpointSource_.reset();
        // Mixer already stopped itself; just clean up state
        state_.store(static_cast<SessionState>(0)); // kIdle
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            activeSourceType_ = "";
        }
        streamGeneration_.fetch_sub(1);
        SimpleJson resp;
        resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
        resp.Set("requestId", static_cast<uint64_t>(0));
        resp.Set("sessionId", config_.sessionId);
        resp.Set("success", false);
        resp.Set("state", "idle");
        resp.Set("error", "mixer-stopped-immediately");
        resp.SetRaw("result", "{}");
        response = resp.Str();
        return;
    }

    // 8. Success
    std::string result = "{";
    result += "\"streamGeneration\":" + std::to_string(gen) + ",";
    result += "\"sourceId\":" + std::to_string(sourceId) + ",";
    result += "\"sourceType\":\"endpoint-loopback\",";
    result += "\"endpointReady\":true";
    result += "}";

    SimpleJson resp;
    resp.Set("protocolVersion", std::string(kServiceProtocolVersion));
    resp.Set("requestId", static_cast<uint64_t>(0));
    resp.Set("sessionId", config_.sessionId);
    resp.Set("success", true);
    resp.Set("state", "capturing");
    resp.SetRaw("result", result);
    resp.Set("error", "null");
    response = resp.Str();
}
```

- [ ] **Step 3: Update OnCapturePacket to use per-boundary counters**

In `OnCapturePacket`, after the state check, add:

```cpp
    if (state_.load() != static_cast<SessionState>(2)) {
        onCaptureRejectedState_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    onCaptureAccepted_.fetch_add(1, std::memory_order_relaxed);
```

And after the mixer output callback in `MixerThread` (this is already handled by the mixer's own diagnostics, but we add session-level tracking). In `OnCapturePacket`, after incrementing `totalPackets_`, also increment:

```cpp
    // Track mixer output at session level
    if (packet.isSilent) {
        // already tracked by mixer
    } else {
        mixerNonZeroOutputPackets_.fetch_add(1, std::memory_order_relaxed);
    }
    mixerOutputPackets_.fetch_add(1, std::memory_order_relaxed);
```

- [ ] **Step 4: Include EndpointLoopbackSource.h in ServiceSession.h**

The `EndpointStartResult` enum is needed by `HandleStartEndpointLoopback`. It's already included via `#include "EndpointLoopbackSource.h"` (line 19 of ServiceSession.h), so no change needed. Verify this is the case.

- [ ] **Step 5: Build and verify compilation**

Run: `cd native\audio-helper && cmake --build build --config Release 2>&1 | Select-Object -Last 20`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add native/audio-helper/src/ServiceSession.h native/audio-helper/src/ServiceSession.cpp
git commit -m "fix(audio): eliminate mixer/state race in HandleStartEndpointLoopback

Reorder startup: set kCapturing BEFORE starting the mixer so
OnCapturePacket accepts the first block. Wait for endpoint WASAPI
readiness before returning success. Add PCM client check (parity with
synthetic). Add per-boundary diagnostic counters. Full atomic rollback
on any failure."
```

---

### Task 4: Fix AudioHelperManager.startEndpointLoopback lifecycle parity

**Files:**
- Modify: `apps/desktop/src/main/AudioHelperManager.ts`

The endpoint method must mirror the synthetic method's post-start lifecycle steps.

- [ ] **Step 1: Update startEndpointLoopback to match synthetic lifecycle**

Replace the current `startEndpointLoopback` method (lines 279-285):

```typescript
  async startEndpointLoopback(): Promise<number> {
    this.ensureReady();
    const result = await this.control!.startEndpointLoopback();
    const gen = result.streamGeneration;
    if (!Number.isSafeInteger(gen)) {
      throw new Error(`Invalid stream generation: ${gen}`);
    }
    this.streamGeneration = gen;
    this.currentSourceType = 'system';
    this.state = 'capturing';
    this.parser?.reset();
    this.pcmBridge.forwardReset(gen);
    this.pcmBridge.sendCanary?.();
    return gen;
  }
```

- [ ] **Step 2: Verify no other changes needed**

The `stopCapture()` method already checks `this.state !== 'capturing'` and returns immediately. With the fix, `this.state` is now `'capturing'` after endpoint start, so stopCapture will work correctly.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/AudioHelperManager.ts
git commit -m "fix(audio): add synthetic-path lifecycle parity to startEndpointLoopback

Set manager state to capturing, reset parser, reset PcmBridge generation,
send canary, and validate stream generation — matching the proven
synthetic capture path."
```

---

### Task 5: Fix Dashboard UI state and diagnostic logging

**Files:**
- Modify: `apps/desktop/src/renderer/routes/Dashboard.tsx`

Two fixes: (1) move the audioTracks log after setAudioController, (2) reset appliedAudioMode in the catch block.

- [ ] **Step 1: Move audioTracks log after setAudioController**

In Dashboard.tsx, around line 571, the log `console.log(\`[Publisher] audioTracks=${mgr.getAudioTrack() ? 1 : 0}\`)` runs before `mgr.setAudioController()`. Move it after line 588 (`mgr.setAudioController(provisionalController, effectiveAudioMode)`):

Find:
```typescript
            console.log(`[Publisher] audioTracks=${mgr.getAudioTrack() ? 1 : 0}`);
            const outputTrack = provisionalController.getTrack();
```

Replace with:
```typescript
            const outputTrack = provisionalController.getTrack();
```

Then after line 588 (`mgr.setAudioController(provisionalController, effectiveAudioMode);`), add:

```typescript
            console.log(`[Publisher] audioTracks=${mgr.getAudioTrack() ? 1 : 0}`);
```

- [ ] **Step 2: Reset appliedAudioMode in the catch block**

In the catch block (around line 594-606), add `setAppliedAudioMode('none')` after `setAudioEnabled(false)`:

Find:
```typescript
          setAudioEnabled(false);
        }
      }
```

Replace with:
```typescript
          setAppliedAudioMode('none');
          setAudioEnabled(false);
        }
      }
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/routes/Dashboard.tsx
git commit -m "fix(audio): move audioTracks log after controller transfer, reset appliedAudioMode on failure

The audioTracks log now reports the correct count after setAudioController.
appliedAudioMode is reset to 'none' in the catch block so the UI does not
imply System Audio is active when the publisher has no audio controller."
```

---

### Task 6: Add per-boundary diagnostic counters to native diagnostics response

**Files:**
- Modify: `native/audio-helper/src/ServiceSession.cpp`
- Modify: `apps/desktop/src/main/ControlClient.ts`
- Modify: `apps/desktop/src/main/AudioHelperManager.ts`

The `HandleGetDiagnostics` response must include the new per-boundary counters, and the TypeScript types must be updated to receive them.

- [ ] **Step 1: Add counters to HandleGetDiagnostics response**

Find `HandleGetDiagnostics` in ServiceSession.cpp. In the result JSON string, add the new fields:

```cpp
    result += ",\"endpointPacketsCaptured\":" + std::to_string(endpointPacketsCaptured_.load());
    result += ",\"endpointNonZeroPackets\":" + std::to_string(endpointNonZeroPackets_.load());
    result += ",\"endpointSilentPackets\":" + std::to_string(endpointSilentPackets_.load());
    result += ",\"mixerFeedPackets\":" + std::to_string(mixerFeedPackets_.load());
    result += ",\"mixerOutputPackets\":" + std::to_string(mixerOutputPackets_.load());
    result += ",\"mixerNonZeroOutputPackets\":" + std::to_string(mixerNonZeroOutputPackets_.load());
    result += ",\"onCaptureAccepted\":" + std::to_string(onCaptureAccepted_.load());
    result += ",\"onCaptureRejectedState\":" + std::to_string(onCaptureRejectedState_.load());
```

- [ ] **Step 2: Update HelperDiagnostics type in ControlClient.ts**

Add the new fields to the `HelperDiagnostics` interface:

```typescript
export interface HelperDiagnostics {
  totalPackets: number;
  totalPayloadBytes: number;
  droppedPackets: number;
  queueSize: number;
  packetsWritten: number;
  writeErrors: number;
  totalControlRequests: number;
  failedControlRequests: number;
  uptimeMs: number;
  activeSourceType: string;
  state: string;
  streamGeneration: number;
  // Per-boundary endpoint/mixer diagnostics
  endpointPacketsCaptured?: number;
  endpointNonZeroPackets?: number;
  endpointSilentPackets?: number;
  mixerFeedPackets?: number;
  mixerOutputPackets?: number;
  mixerNonZeroOutputPackets?: number;
  onCaptureAccepted?: number;
  onCaptureRejectedState?: number;
}
```

- [ ] **Step 3: Update PcmPipelineSnapshot in AudioHelperManager.ts**

Add the new fields to `PcmPipelineSnapshot`:

```typescript
export interface PcmPipelineSnapshot {
  // ... existing fields ...
  endpointPacketsCaptured?: number;
  endpointNonZeroPackets?: number;
  endpointSilentPackets?: number;
  mixerFeedPackets?: number;
  mixerOutputPackets?: number;
  mixerNonZeroOutputPackets?: number;
  onCaptureAccepted?: number;
  onCaptureRejectedState?: number;
}
```

And in `getPipelineSnapshot()`, populate them:

```typescript
      endpointPacketsCaptured: helperDiag ? (helperDiag as any).endpointPacketsCaptured ?? undefined : undefined,
      endpointNonZeroPackets: helperDiag ? (helperDiag as any).endpointNonZeroPackets ?? undefined : undefined,
      endpointSilentPackets: helperDiag ? (helperDiag as any).endpointSilentPackets ?? undefined : undefined,
      mixerFeedPackets: helperDiag ? (helperDiag as any).mixerFeedPackets ?? undefined : undefined,
      mixerOutputPackets: helperDiag ? (helperDiag as any).mixerOutputPackets ?? undefined : undefined,
      mixerNonZeroOutputPackets: helperDiag ? (helperDiag as any).mixerNonZeroOutputPackets ?? undefined : undefined,
      onCaptureAccepted: helperDiag ? (helperDiag as any).onCaptureAccepted ?? undefined : undefined,
      onCaptureRejectedState: helperDiag ? (helperDiag as any).onCaptureRejectedState ?? undefined : undefined,
```

- [ ] **Step 4: Build native and verify**

Run: `cd native\audio-helper && cmake --build build --config Release 2>&1 | Select-Object -Last 20`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add native/audio-helper/src/ServiceSession.cpp apps/desktop/src/main/ControlClient.ts apps/desktop/src/main/AudioHelperManager.ts
git commit -m "feat(audio): add per-boundary diagnostic counters for endpoint/mixer pipeline

Expose endpointPacketsCaptured, endpointNonZeroPackets, mixerFeedPackets,
mixerOutputPackets, onCaptureAccepted, onCaptureRejectedState in the
diagnostics response and pipeline snapshot. Enables tracing the full
native→pipe→bridge→worklet route."
```

---

### Task 7: Rename misleading synthPacketsProduced counter

**Files:**
- Modify: `native/audio-helper/src/ServiceSession.h`
- Modify: `native/audio-helper/src/ServiceSession.cpp`

The counter `synthPacketsProduced_` is incremented for ALL sources including System Audio, which is semantically misleading.

- [ ] **Step 1: Rename the counter**

In ServiceSession.h, rename:
```cpp
    std::atomic<uint64_t> synthPacketsProduced_{0};
    std::atomic<uint64_t> synthBytesProduced_{0};
```
to:
```cpp
    std::atomic<uint64_t> capturePacketsProduced_{0};
    std::atomic<uint64_t> captureBytesProduced_{0};
```

In ServiceSession.cpp `OnCapturePacket`, change:
```cpp
    synthPacketsProduced_.fetch_add(1, std::memory_order_relaxed);
    synthBytesProduced_.fetch_add(hdr.payloadBytes, std::memory_order_relaxed);
```
to:
```cpp
    capturePacketsProduced_.fetch_add(1, std::memory_order_relaxed);
    captureBytesProduced_.fetch_add(hdr.payloadBytes, std::memory_order_relaxed);
```

Update the diagnostics response in `HandleGetDiagnostics` to use the new name:
```cpp
    result += ",\"capturePacketsProduced\":" + std::to_string(capturePacketsProduced_.load());
    result += ",\"captureBytesProduced\":" + std::to_string(captureBytesProduced_.load());
```

- [ ] **Step 2: Update AudioHelperManager.ts pipeline snapshot**

In `getPipelineSnapshot()`, update the field names:

```typescript
      capturePacketsProduced: helperDiag ? (helperDiag as any).capturePacketsProduced ?? (helperDiag as any).synthPacketsProduced ?? undefined : undefined,
      captureBytesProduced: helperDiag ? (helperDiag as any).captureBytesProduced ?? (helperDiag as any).synthBytesProduced ?? undefined : undefined,
```

And update `PcmPipelineSnapshot`:
```typescript
  capturePacketsProduced?: number;
  captureBytesProduced?: number;
  // Deprecated aliases (kept for backward compat during rollout)
  synthPacketsProduced?: number;
  synthBytesProduced?: number;
```

- [ ] **Step 3: Build and commit**

```bash
git add native/audio-helper/src/ServiceSession.h native/audio-helper/src/ServiceSession.cpp apps/desktop/src/main/AudioHelperManager.ts
git commit -m "refactor(audio): rename synthPacketsProduced to capturePacketsProduced

The counter is incremented for all capture sources, not just synthetic.
Rename to avoid confusion when diagnosing System Audio issues."
```

---

### Task 8: Verify Test Tone still works (regression test)

**Files:** None (manual verification)

- [ ] **Step 1: Build the native helper**

Run: `cd native\audio-helper && cmake --build build --config Release`
Expected: Build succeeds.

- [ ] **Step 2: Run the Test Tone end-to-end**

Start the app, select "Test Tone" audio mode, share screen. Verify:
- Audio track appears in sender table
- Viewer hears 440 Hz tone
- `getPipelineSnapshot()` shows increasing `onCaptureAccepted` and `bridgePacketsForwarded`

If Test Tone breaks, the changes introduced a regression — debug and fix before proceeding.

---

### Task 9: Verify System Audio works (integration test)

**Files:** None (manual verification)

- [ ] **Step 1: Test System Audio with silent desktop**

Start the app, select "System Audio", share screen with no audio playing. Verify:
- Audio track appears in sender table (track is live even though content is silent)
- `getPipelineSnapshot()` shows `endpointReady: true`, `endpointPacketsCaptured > 0`, `onCaptureAccepted > 0`
- `onCaptureRejectedState` is 0

- [ ] **Step 2: Test System Audio with active playback**

Play music/video on the desktop. Verify:
- Viewer hears the desktop audio
- `endpointNonZeroPackets > 0`
- `mixerNonZeroOutputPackets > 0`
- Audio quality is clean (no garbage, no silence when audio is playing)

- [ ] **Step 3: Test System Audio failure handling**

Disconnect audio endpoint (e.g., disable audio device in Windows settings) and verify:
- Native helper reports a structured error (not silent success)
- Dashboard resets `appliedAudioMode` to `'none'`
- Video continues without audio

---

## Self-Review Checklist

- [x] **Spec coverage:** Each of the 9 defects from the analysis maps to a task:
  1. Mixer/state race → Task 3
  2. Endpoint Start() reports success before WASAPI starts → Task 1
  3. Missing Test Tone parity in AudioHelperManager → Task 4
  4. Missing PCM client readiness check → Task 3
  5. Contradictory format conversion → Task 2
  6. False success from mixer silence → Task 1 (endpointReady handshake) + Task 3 (verify mixer running)
  7. Cleanup defects (audioClient_ ownership, destructor ordering) → Task 1
  8. Missing per-boundary diagnostics → Task 6 + Task 7
  9. Dashboard UI state issues → Task 5

- [x] **Placeholder scan:** No TBD, TODO, or "implement later" patterns. All code is shown.

- [x] **Type consistency:** `EndpointStartResult` enum defined in Task 1, used in Task 3. `EndpointStartOutcome` struct defined in Task 1, returned by `Start()` in Task 1, consumed in Task 3. `HelperDiagnostics` updated in Task 6. `PcmPipelineSnapshot` updated in Tasks 6 and 7.

- [x] **No new files created** — all changes are to existing files.
