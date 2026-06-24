#include "EndpointLoopbackSource.h"
#include "SyntheticSource.h" // for GetQpcFrequency

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <vector>

namespace screenlink::audio {

// ========================================================================
// Helpers
// ========================================================================

namespace {

std::string HresultToString(HRESULT hr) {
    char buf[32] = {};
    snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

template <typename T>
void SafeRelease(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
}

// ── Target output format ──

static constexpr uint32_t kTargetSampleRate = 48000;
static constexpr uint16_t kTargetChannels = 2;
static constexpr uint16_t kTargetBitsPerSample = 32;

// ── Channel mask bits ──
// NOTE: SPEAKER_FRONT_LEFT etc. are already defined as preprocessor
// macros by <audioclient.h> → <ksmedia.h>. Do not redefine them.

// ── Downmix coefficient table ──
// Maps each speaker position to (leftGain, rightGain) for stereo downmix.
struct ChannelCoeff { float left; float right; };

ChannelCoeff GetDownmixCoeff(DWORD speakerPos) {
    switch (speakerPos) {
        case SPEAKER_FRONT_LEFT:            return {1.0f, 0.0f};
        case SPEAKER_FRONT_RIGHT:           return {0.0f, 1.0f};
        case SPEAKER_FRONT_CENTER:          return {0.707f, 0.707f};
        case SPEAKER_LOW_FREQUENCY:         return {0.25f, 0.25f};  // LFE at reduced level
        case SPEAKER_BACK_LEFT:             return {0.707f, 0.0f};
        case SPEAKER_BACK_RIGHT:            return {0.0f, 0.707f};
        case SPEAKER_FRONT_LEFT_OF_CENTER:  return {0.707f, 0.0f};
        case SPEAKER_FRONT_RIGHT_OF_CENTER: return {0.0f, 0.707f};
        case SPEAKER_SIDE_LEFT:             return {0.707f, 0.0f};
        case SPEAKER_SIDE_RIGHT:            return {0.0f, 0.707f};
        case SPEAKER_TOP_FRONT_LEFT:        return {0.5f, 0.0f};
        case SPEAKER_TOP_FRONT_RIGHT:       return {0.0f, 0.5f};
        case SPEAKER_TOP_FRONT_CENTER:      return {0.5f, 0.5f};
        case SPEAKER_TOP_CENTER:            return {0.5f, 0.5f};
        case SPEAKER_TOP_BACK_LEFT:         return {0.5f, 0.0f};
        case SPEAKER_TOP_BACK_RIGHT:        return {0.0f, 0.5f};
        case SPEAKER_TOP_BACK_CENTER:       return {0.5f, 0.5f};
        default:                            return {0.0f, 0.0f};
    }
}

// ── Source format descriptor ──

struct SourceFormat {
    uint32_t sampleRate = 0;
    uint16_t channels = 0;
    uint16_t bitsPerSample = 0;
    bool isFloat = false;
    DWORD channelMask = 0; // 0 = unknown/use default order
};

// ── WASAPI initialization helper ──
// Encapsulates the full endpoint + IAudioClient + IAudioCaptureClient setup.
// Used for initial startup and for device recovery.

struct WasapiInitResult {
    bool success = false;
    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
    WAVEFORMATEX* mixFormat = nullptr;
    EndpointStartResult startResult = EndpointStartResult::Success;
    HRESULT hr = S_OK;

    void Reset() {
        enumerator = nullptr;
        device = nullptr;
        audioClient = nullptr;
        captureClient = nullptr;
        mixFormat = nullptr;
        startResult = EndpointStartResult::Success;
        hr = S_OK;
    }
};

WasapiInitResult InitializeWasapiEndpoint() {
    WasapiInitResult result;

    // ── 2. Create device enumerator ──
    IMMDeviceEnumerator* pEnumerator = nullptr;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        reinterpret_cast<void**>(&pEnumerator));
    if (FAILED(hr) || !pEnumerator) {
        std::cerr << "[EndpointLoopback] CoCreateInstance(MMDeviceEnumerator) failed: "
                  << HresultToString(hr) << std::endl;
        result.startResult = EndpointStartResult::EnumeratorFailed;
        result.hr = hr;
        return result;
    }

    // ── 3. Get default render endpoint ──
    IMMDevice* pDevice = nullptr;
    hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    if (FAILED(hr) || !pDevice) {
        std::cerr << "[EndpointLoopback] GetDefaultAudioEndpoint failed: "
                  << HresultToString(hr) << std::endl;
        SafeRelease(pEnumerator);
        result.startResult = EndpointStartResult::EndpointNotFound;
        result.hr = hr;
        return result;
    }

    // ── 4. Activate IAudioClient ──
    IAudioClient* pAudioClient = nullptr;
    hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL,
                           nullptr, reinterpret_cast<void**>(&pAudioClient));
    SafeRelease(pDevice); // device no longer needed once we have the client
    if (FAILED(hr) || !pAudioClient) {
        std::cerr << "[EndpointLoopback] Activate(IAudioClient) failed: "
                  << HresultToString(hr) << std::endl;
        SafeRelease(pEnumerator);
        result.startResult = EndpointStartResult::AudioClientActivationFailed;
        result.hr = hr;
        return result;
    }

    // ── 5. Get mix format ──
    WAVEFORMATEX* pMixFormat = nullptr;
    hr = pAudioClient->GetMixFormat(&pMixFormat);
    if (FAILED(hr) || !pMixFormat) {
        std::cerr << "[EndpointLoopback] GetMixFormat failed: "
                  << HresultToString(hr) << std::endl;
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        result.startResult = EndpointStartResult::GetMixFormatFailed;
        result.hr = hr;
        return result;
    }

    // ── 6. Describe source format (informational) ──
    SourceFormat srcFmt;
    srcFmt.sampleRate = pMixFormat->nSamplesPerSec;
    srcFmt.channels = pMixFormat->nChannels;
    srcFmt.bitsPerSample = pMixFormat->wBitsPerSample;
    srcFmt.isFloat = (pMixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);

    if (pMixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE && pMixFormat->cbSize >= 22) {
        auto pExt = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(pMixFormat);
        srcFmt.channelMask = pExt->dwChannelMask;
        if (pExt->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) {
            srcFmt.isFloat = true;
        } else {
            srcFmt.isFloat = false;
        }
    }

    // ── 7. Build target format ──
    WAVEFORMATEXTENSIBLE targetFmt = {};
    targetFmt.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    targetFmt.Format.nChannels = kTargetChannels;
    targetFmt.Format.nSamplesPerSec = kTargetSampleRate;
    targetFmt.Format.wBitsPerSample = kTargetBitsPerSample;
    targetFmt.Format.nBlockAlign = kTargetChannels * (kTargetBitsPerSample / 8);
    targetFmt.Format.nAvgBytesPerSec = kTargetSampleRate * targetFmt.Format.nBlockAlign;
    targetFmt.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    targetFmt.Samples.wValidBitsPerSample = kTargetBitsPerSample;
    targetFmt.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    targetFmt.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;

    // ── 8. Initialize audio client in loopback mode ──
    REFERENCE_TIME bufferDuration = 100000; // 100 ns units = 10 ms

    hr = pAudioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        bufferDuration,
        0,
        reinterpret_cast<WAVEFORMATEX*>(&targetFmt),
        nullptr);

    if (FAILED(hr)) {
        std::cerr << "[EndpointLoopback] IAudioClient::Initialize failed: "
                  << HresultToString(hr) << std::endl;

        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
            std::cerr << "[EndpointLoopback] Device invalidated during init" << std::endl;
        }

        CoTaskMemFree(pMixFormat);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        result.startResult = EndpointStartResult::InitializeFailed;
        result.hr = hr;
        return result;
    }

    // ── 9. Get capture client ──
    IAudioCaptureClient* pCaptureClient = nullptr;
    hr = pAudioClient->GetService(
        __uuidof(IAudioCaptureClient),
        reinterpret_cast<void**>(&pCaptureClient));
    if (FAILED(hr) || !pCaptureClient) {
        std::cerr << "[EndpointLoopback] GetService(IAudioCaptureClient) failed: "
                  << HresultToString(hr) << std::endl;
        CoTaskMemFree(pMixFormat);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        result.startResult = EndpointStartResult::CaptureClientFailed;
        result.hr = hr;
        return result;
    }

    // ── Get buffer size (informational / validation) ──
    UINT32 bufferFrameCount = 0;
    hr = pAudioClient->GetBufferSize(&bufferFrameCount);
    if (FAILED(hr)) {
        std::cerr << "[EndpointLoopback] GetBufferSize failed: "
                  << HresultToString(hr) << std::endl;
        CoTaskMemFree(pMixFormat);
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        result.startResult = EndpointStartResult::InitializeFailed;
        result.hr = hr;
        return result;
    }

    // Success — populate result
    result.success = true;
    result.enumerator = pEnumerator;
    result.audioClient = pAudioClient;
    result.captureClient = pCaptureClient;
    result.mixFormat = pMixFormat;
    // pDevice was already released after Activate — we don't cache it
    // The caller doesn't need pDevice once we have the client.
    return result;
}

} // anonymous namespace

// ── Linear interpolation sample-rate converter ──
//
// Stateful resampler that converts from an arbitrary source rate to
// kTargetSampleRate (48000). Keeps a fractional phase position across calls.
// Defined in screenlink::audio namespace (not anonymous) so the
// EndpointLoopbackSource header forward declaration works.

class LinearResampler {
public:
    LinearResampler() = default;

    /// Configure for a given source sample rate and number of channels.
    /// Call this when the source format is known (or when it changes).
    void Configure(uint32_t sourceRate, uint16_t numChannels) {
        sourceRate_ = sourceRate;
        channels_ = numChannels;
        if (sourceRate > 0) {
            step_ = static_cast<double>(sourceRate) / static_cast<double>(kTargetSampleRate);
        } else {
            step_ = 1.0;
        }
        // Reset phase when reconfiguring
        phase_ = 0.0;
    }

    /// Resample input frames to output frames.
    /// @param input       Input interleaved float32 samples (source rate)
    /// @param inputFrames Number of input frames
    /// @param[out] output Output vector, will be appended to
    /// @return Number of output frames produced
    uint32_t Process(const float* input, uint32_t inputFrames,
                     std::vector<float>& output) {
        if (sourceRate_ == kTargetSampleRate || sourceRate_ == 0) {
            // No resampling needed — pass through
            size_t sampleCount = static_cast<size_t>(inputFrames) * channels_;
            output.insert(output.end(), input, input + sampleCount);
            return inputFrames;
        }

        uint32_t outputFrames = 0;

        // If this is the first call, save the first sample for interpolation
        if (!hasPrev_) {
            for (uint16_t ch = 0; ch < channels_; ++ch) {
                prevSample_[ch] = input[ch];
            }
            hasPrev_ = true;
        }

        size_t inputIdx = 0;
        const size_t totalInputSamples = static_cast<size_t>(inputFrames) * channels_;

        while (inputIdx < totalInputSamples) {
            // Determine the current input frame index
            size_t frameIdx = static_cast<size_t>(phase_);
            
            // Clamp to valid range
            if (frameIdx >= static_cast<size_t>(inputFrames)) {
                break;
            }

            // Interpolate between frameIdx and frameIdx+1
            float frac = static_cast<float>(phase_ - static_cast<double>(frameIdx));
            if (frameIdx + 1 >= static_cast<size_t>(inputFrames)) {
                // Last frame — use only the current frame (no forward interpolation)
                for (uint16_t ch = 0; ch < channels_; ++ch) {
                    size_t pos = frameIdx * channels_ + ch;
                    output.push_back(input[pos]);
                }
                phase_ += step_;
                outputFrames++;
                // Check if the next sample would be beyond the input
                if (phase_ >= static_cast<double>(inputFrames)) {
                    // Save last sample for next batch
                    size_t lastPos = (inputFrames - 1) * channels_;
                    for (uint16_t ch = 0; ch < channels_; ++ch) {
                        prevSample_[ch] = input[lastPos + ch];
                    }
                    phase_ -= static_cast<double>(inputFrames);
                }
                continue;
            }

            for (uint16_t ch = 0; ch < channels_; ++ch) {
                size_t pos0 = frameIdx * channels_ + ch;
                size_t pos1 = (frameIdx + 1) * channels_ + ch;
                float sample = input[pos0] * (1.0f - frac) + input[pos1] * frac;
                output.push_back(sample);
            }

            phase_ += step_;
            outputFrames++;

            // If phase advanced past the last input frame, we need new data
            if (phase_ >= static_cast<double>(inputFrames)) {
                // Save last sample of this batch for next Process() call
                // (used for the fractional interpolation edge)
                size_t lastPos = (inputFrames - 1) * channels_;
                for (uint16_t ch = 0; ch < channels_; ++ch) {
                    prevSample_[ch] = input[lastPos + ch];
                }
                phase_ -= static_cast<double>(inputFrames);
                break;
            }
        }

        return outputFrames;
    }

    /// Reset the internal state (phase, previous sample).
    void Reset() {
        phase_ = 0.0;
        hasPrev_ = false;
        for (auto& s : prevSample_) s = 0.0f;
    }

    uint32_t SourceRate() const { return sourceRate_; }

private:
    uint32_t sourceRate_ = 0;
    uint16_t channels_ = 2;
    double step_ = 1.0;    // input frames per output frame
    double phase_ = 0.0;   // fractional position in input frame units
    bool hasPrev_ = false;
    float prevSample_[8] = {}; // max 8 channels for prev-sample caching
};

// ── Channel mapper for multichannel-to-stereo downmix ──
//
// Given a channel mask and source format, maps each source channel
// index to left/right output contribution.

class ChannelDownmixer {
public:
    ChannelDownmixer() = default;

    /// Configure for a given source channel count and mask.
    void Configure(uint16_t numChannels, DWORD channelMask) {
        channels_ = numChannels;
        channelMask_ = channelMask;

        // Build per-channel coefficient table
        coeffs_.resize(numChannels);
        for (auto& c : coeffs_) { c = {0.0f, 0.0f}; }

        if (channelMask != 0 && numChannels > 0) {
            // Map each set bit in the mask to a channel index
            DWORD remainingMask = channelMask;
            DWORD knownSpeakers[] = {
                SPEAKER_FRONT_LEFT, SPEAKER_FRONT_RIGHT,
                SPEAKER_FRONT_CENTER, SPEAKER_LOW_FREQUENCY,
                SPEAKER_BACK_LEFT, SPEAKER_BACK_RIGHT,
                SPEAKER_FRONT_LEFT_OF_CENTER, SPEAKER_FRONT_RIGHT_OF_CENTER,
                SPEAKER_SIDE_LEFT, SPEAKER_SIDE_RIGHT,
                SPEAKER_TOP_FRONT_LEFT, SPEAKER_TOP_FRONT_RIGHT,
                SPEAKER_TOP_FRONT_CENTER, SPEAKER_TOP_CENTER,
                SPEAKER_TOP_BACK_LEFT, SPEAKER_TOP_BACK_RIGHT,
                SPEAKER_TOP_BACK_CENTER
            };

            uint16_t chIdx = 0;
            for (auto spk : knownSpeakers) {
                if (remainingMask & spk) {
                    remainingMask &= ~spk;
                    if (chIdx < numChannels) {
                        coeffs_[chIdx] = GetDownmixCoeff(spk);
                        chIdx++;
                    }
                }
            }
            // Any remaining channels (unknown mask bits) get silence in downmix
        } else if (numChannels == 1) {
            // Mono: duplicate to both L and R
            coeffs_[0] = {1.0f, 1.0f};
        } else if (numChannels >= 2) {
            // Unknown mask, assume standard channel order:
            // FL, FR, C, LFE, (rest silent)
            coeffs_[0] = {1.0f, 0.0f}; // FL
            coeffs_[1] = {0.0f, 1.0f}; // FR
            if (numChannels >= 3) coeffs_[2] = {0.707f, 0.707f}; // C
            if (numChannels >= 4) coeffs_[3] = {0.25f, 0.25f};   // LFE
            // Channels 5+ (BL, BR, etc.) — use standard order
            if (numChannels >= 5) coeffs_[4] = {0.707f, 0.0f};   // BL/SL
            if (numChannels >= 6) coeffs_[5] = {0.0f, 0.707f};   // BR/SR
            if (numChannels >= 7) coeffs_[6] = {0.5f, 0.0f};     // extra left
            if (numChannels >= 8) coeffs_[7] = {0.0f, 0.5f};     // extra right
        }
    }

    /// Downmix one frame of interleaved float32 input to stereo.
    /// @param input  Pointer to one frame of interleaved input (numChannels samples)
    /// @param left   Output left sample
    /// @param right  Output right sample
    void ProcessFrame(const float* input, float& left, float& right) const {
        left = 0.0f;
        right = 0.0f;
        for (uint16_t ch = 0; ch < channels_; ++ch) {
            left  += input[ch] * coeffs_[ch].left;
            right += input[ch] * coeffs_[ch].right;
        }
    }

private:
    uint16_t channels_ = 2;
    DWORD channelMask_ = 0;
    std::vector<ChannelCoeff> coeffs_;
};

// ========================================================================
// EndpointLoopbackSource
// ========================================================================

EndpointLoopbackSource::EndpointLoopbackSource() {
    resampler_ = new LinearResampler();
}

EndpointLoopbackSource::~EndpointLoopbackSource() {
    Stop();
    delete resampler_;
    resampler_ = nullptr;
}

void EndpointLoopbackSource::SignalStartupComplete(EndpointStartResult result, HRESULT hr) {
    std::lock_guard<std::mutex> lock(startupMutex_);
    startupOutcome_.result = result;
    startupOutcome_.hr = hr;
    startupComplete_ = true;
    startupCv_.notify_one();
}

EndpointStartOutcome EndpointLoopbackSource::Start(
    std::function<bool(const AudioPacket&)> onPacket) {
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
                [this] { return startupComplete_; }))
        {
            // Timeout — WASAPI init took too long
            running_.store(false);
            if (captureThread_.joinable()) captureThread_.join();
            out.result = EndpointStartResult::InitializeFailed;
            out.hr = HRESULT_FROM_WIN32(WAIT_TIMEOUT);
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

void EndpointLoopbackSource::Stop() {
    if (!running_.load()) {
        if (captureThread_.joinable()) {
            captureThread_.join();
        }
        return;
    }

    // Signal the capture thread to stop
    running_.store(false);

    // Wake any blocked WASAPI call by stopping the audio client.
    // IAudioClient::Stop() causes GetBuffer / GetNextPacketSize to return
    // or wake up on the capture thread, allowing it to see running_ == false.
    if (IAudioClient* client = audioClient_.load()) {
        client->Stop();
    }

    if (captureThread_.joinable()) {
        captureThread_.join();
    }
}

EndpointLoopbackDiagnostics EndpointLoopbackSource::GetDiagnostics() const {
    std::lock_guard<std::mutex> lock(diagMutex_);
    EndpointLoopbackDiagnostics d = diag_;
    d.running = running_.load();
    return d;
}

// ========================================================================
// RecoverEndpoint — exponential-backoff device recovery
// ========================================================================
//
// Called when AUDCLNT_E_DEVICE_INVALIDATED is encountered during active
// capture. Waits with backoff (250ms → 500ms → 1000ms → 2000ms), then
// attempts to reinitialize the WASAPI endpoint loopback. Returns true if
// a new session was successfully created (stored in recoverySession_).
// Returns false if cancelled (Stop() called) or all retries exhausted.

bool EndpointLoopbackSource::RecoverEndpoint() {
    static const DWORD backoffMs[] = {250, 500, 1000, 2000};
    const int maxRetries = static_cast<int>(sizeof(backoffMs) / sizeof(backoffMs[0]));

    for (int retry = 0; retry < maxRetries && running_.load(); ++retry) {
        // ── Backoff: sleep in 10ms increments to detect cancellation ──
        DWORD waitMs = backoffMs[retry];
        for (DWORD elapsed = 0; elapsed < waitMs && running_.load(); elapsed += 10) {
            Sleep(10);
        }
        if (!running_.load()) {
            return false; // Stop() was called
        }

        // ── Try to reinitialize the WASAPI endpoint ──
        WasapiInitResult init = InitializeWasapiEndpoint();
        if (init.success) {
            // Store recovered session for CaptureThread to pick up
            recoverySession_.enumerator = init.enumerator;
            recoverySession_.device = init.device;
            recoverySession_.audioClient = init.audioClient;
            recoverySession_.captureClient = init.captureClient;
            recoverySession_.mixFormat = init.mixFormat;

            // Clear pointers in init so its destructor doesn't release them
            init.Reset();

            std::cerr << "[EndpointLoopback] Device recovered after "
                      << (retry + 1) << " attempt(s)" << std::endl;
            return true;
        }

        // Init failed — release partial resources (Reset ensures non-null members
        // are freed; init goes out of scope here but was Reset on success above).
        // On failure, InitializeWasapiEndpoint already cleaned up partial
        // allocations so we just log and retry.
        std::cerr << "[EndpointLoopback] Recovery attempt " << (retry + 1)
                  << " failed: " << HresultToString(init.hr) << std::endl;

        {
            std::lock_guard<std::mutex> lock(diagMutex_);
            diag_.lastHresult = init.hr;
            diag_.lastError = "Recovery attempt " + std::to_string(retry + 1) + " failed";
        }
    }

    // All retries exhausted
    {
        std::lock_guard<std::mutex> lock(diagMutex_);
        diag_.initializationFailures++;
        diag_.lastError = "All recovery retries exhausted";
    }
    std::cerr << "[EndpointLoopback] Recovery failed after "
              << maxRetries << " attempts" << std::endl;
    return false;
}

// ========================================================================
// CaptureThread — WASAPI endpoint loopback capture loop
// ========================================================================

void EndpointLoopbackSource::CaptureThread(
    std::function<bool(const AudioPacket&)> onPacket)
{
    // ── 1. Initialize COM ──
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        std::cerr << "[EndpointLoopback] CoInitializeEx failed: "
                  << HresultToString(hr) << std::endl;
        SignalStartupComplete(EndpointStartResult::ComInitFailed, hr);
        running_.store(false);
        return;
    }

    if (!running_.load()) {
        SignalStartupComplete(EndpointStartResult::Cancelled, S_OK);
        CoUninitialize();
        return;
    }

    // ── Persistent state (survives recovery) ──
    uint64_t sequenceNumber = 0;
    uint64_t framesCaptured = 0;
    DWORD avrtTaskIndex = 0;
    HANDLE avrtHandle = nullptr;
    bool firstStartup = true; // true until we signal readiness to Start()

    // ── OUTER LOOP: supports device recovery ──
    // On first entry performs the initial WASAPI setup and signals readiness.
    // On subsequent entries (after device invalidation) picks up a recovered
    // session from recoverySession_ (set by RecoverEndpoint()).
    while (running_.load()) {
        // ── WASAPI session pointers (reacquired each iteration) ──
        IMMDeviceEnumerator* pEnumerator = nullptr;
        IMMDevice* pDevice = nullptr;
        IAudioClient* pAudioClient = nullptr;
        IAudioCaptureClient* pCaptureClient = nullptr;
        WAVEFORMATEX* pMixFormat = nullptr;
        bool isRecoveredSession = false;

        if (firstStartup) {
            // ── Initial WASAPI setup (no backoff — fail fast) ──
            WasapiInitResult init = InitializeWasapiEndpoint();
            if (!init.success) {
                std::cerr << "[EndpointLoopback] Initial WASAPI init failed: "
                          << HresultToString(init.hr) << std::endl;
                SignalStartupComplete(init.startResult, init.hr);
                break;
            }

            pEnumerator = init.enumerator;
            pDevice = init.device;
            pAudioClient = init.audioClient;
            pCaptureClient = init.captureClient;
            pMixFormat = init.mixFormat;
            // Clear init pointers so we own them
            init.Reset();
        } else {
            // ── Recovery: use session from RecoverEndpoint() ──
            if (!recoverySession_.IsValid()) {
                // No valid recovery session — should not happen if RecoverEndpoint succeeded
                break;
            }

            pEnumerator = recoverySession_.enumerator;
            pDevice = recoverySession_.device;
            pAudioClient = recoverySession_.audioClient;
            pCaptureClient = recoverySession_.captureClient;
            pMixFormat = recoverySession_.mixFormat;
            recoverySession_ = WasapiSession{}; // clear
            isRecoveredSession = true;
        }

        // At this point we own all session pointers. pDevice may be null
        // since InitializeWasapiEndpoint releases it after Activate.
        // That's fine — we don't need pDevice past activation.

        // ── If Stop() was called during setup, bail out ──
        if (!running_.load()) {
            if (pAudioClient) pAudioClient->Stop();
            SafeRelease(pCaptureClient);
            SafeRelease(pAudioClient);
            SafeRelease(pEnumerator);
            if (pMixFormat) CoTaskMemFree(pMixFormat);
            // pDevice is null (released by InitializeWasapiEndpoint)
            if (firstStartup) {
                SignalStartupComplete(EndpointStartResult::Cancelled, S_OK);
            }
            break;
        }

        // ── Check for device-invalidated during init (unlikely but possible) ──
        // The InitializeWasapiEndpoint handles AUDCLNT_E_DEVICE_INVALIDATED
        // and returns it as InitializeFailed. If the first startup hits this,
        // we'll fail below. If recovery hits this, we'll go through recovery
        // again after backoff.

        // ── Start the audio engine ──
        hr = pAudioClient->Start();
        if (FAILED(hr)) {
            std::cerr << "[EndpointLoopback] IAudioClient::Start failed: "
                      << HresultToString(hr) << std::endl;
            SafeRelease(pCaptureClient);
            SafeRelease(pAudioClient);
            SafeRelease(pEnumerator);
            if (pMixFormat) CoTaskMemFree(pMixFormat);
            if (firstStartup) {
                SignalStartupComplete(EndpointStartResult::AudioEngineStartFailed, hr);
            }
            break;
        }

        // ── Make the client accessible to Stop() ──
        audioClient_.store(pAudioClient);

        // ── Signal readiness (only on first startup) ──
        if (firstStartup) {
            SignalStartupComplete(EndpointStartResult::Success, S_OK);
            firstStartup = false;

            // Set Pro Audio thread priority
            avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &avrtTaskIndex);

            std::cerr << "[EndpointLoopback] Capture started" << std::endl;
        } else {
            // Recovery success
            {
                std::lock_guard<std::mutex> lock(diagMutex_);
                diag_.deviceRestarts++;
                diag_.lastHresult = S_OK;
                diag_.lastError.clear();
            }
            std::cerr << "[EndpointLoopback] Capture resumed after recovery" << std::endl;
        }

        // ── Pre-allocate conversion buffers ──
        conversionBuffer_.clear();
        stereoBuffer_.clear();
        resampleBuffer_.clear();

        // ── CAPTURE LOOP ──
        bool deviceInvalidated = false;

        while (running_.load() && !deviceInvalidated) {
            // Get the next available packet size
            UINT32 packetSize = 0;
            hr = pCaptureClient->GetNextPacketSize(&packetSize);
            if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
                std::cerr << "[EndpointLoopback] Device invalidated — recovering" << std::endl;
                deviceInvalidated = true;
                {
                    std::lock_guard<std::mutex> lock(diagMutex_);
                    diag_.deviceInvalidations++;
                    diag_.lastHresult = hr;
                    diag_.lastError = "Device invalidated";
                }
                break;
            }
            if (FAILED(hr)) {
                std::cerr << "[EndpointLoopback] GetNextPacketSize failed: "
                          << HresultToString(hr) << std::endl;
                {
                    std::lock_guard<std::mutex> lock(diagMutex_);
                    diag_.lastHresult = hr;
                    diag_.lastError = "GetNextPacketSize failed";
                }
                running_.store(false);
                break;
            }

            while (packetSize > 0 && running_.load() && !deviceInvalidated) {
                BYTE* pData = nullptr;
                UINT32 numFramesAvailable = 0;
                DWORD flags = 0;
                UINT64 devicePosition = 0;
                UINT64 qpcPosition = 0;

                hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable,
                                               &flags, &devicePosition, &qpcPosition);
                if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
                    std::cerr << "[EndpointLoopback] Device invalidated during GetBuffer" << std::endl;
                    deviceInvalidated = true;
                    {
                        std::lock_guard<std::mutex> lock(diagMutex_);
                        diag_.deviceInvalidations++;
                        diag_.lastHresult = hr;
                        diag_.lastError = "Device invalidated";
                    }
                    break;
                }
                if (FAILED(hr)) {
                    std::cerr << "[EndpointLoopback] GetBuffer failed: "
                              << HresultToString(hr) << std::endl;
                    {
                        std::lock_guard<std::mutex> lock(diagMutex_);
                        diag_.lastHresult = hr;
                        diag_.lastError = "GetBuffer failed";
                    }
                    running_.store(false);
                    break;
                }

                if (numFramesAvailable == 0) {
                    pCaptureClient->ReleaseBuffer(numFramesAvailable);
                    break;
                }

                // ── Build AudioPacket ──
                AudioPacket packet{};
                packet.frameCount = numFramesAvailable;
                packet.channels = kTargetChannels;
                packet.sequenceNumber = sequenceNumber;
                packet.qpcPosition100ns = qpcPosition;
                packet.devicePosition = devicePosition;
                packet.isDiscontinuous =
                    (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0;
                packet.hasTimestampError =
                    (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0;
                packet.sourceId = 0; // endpoint source

                // ── Format conversion ──
                // With AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, WASAPI delivers data
                // in our target format (48 kHz stereo float).

                bool isWasapiSilent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                if (isWasapiSilent) {
                    // Zero-fill silent frames to preserve timeline
                    size_t totalSamples =
                        static_cast<size_t>(numFramesAvailable) * kTargetChannels;
                    conversionBuffer_.assign(totalSamples, 0.0f);
                    packet.frames = conversionBuffer_.data();
                    packet.isSilent = true;
                } else {
                    // AUTOCONVERTPCM delivers in target format directly
                    packet.frames = reinterpret_cast<const float*>(pData);
                }
                packet.channels = kTargetChannels;

                // ── Update diagnostics ──
                {
                    std::lock_guard<std::mutex> lock(diagMutex_);
                    diag_.packetsCaptured++;
                    diag_.endpointActive = true;
                    diag_.running = true;
                    if (isWasapiSilent) {
                        diag_.silentPackets++;
                    } else {
                        // Check if any sample is non-zero
                        bool nonZero = false;
                        size_t totalSamples =
                            static_cast<size_t>(numFramesAvailable) * kTargetChannels;
                        const float* frames = reinterpret_cast<const float*>(pData);
                        for (size_t i = 0; i < totalSamples && !nonZero; ++i) {
                            if (frames[i] != 0.0f) nonZero = true;
                        }
                        if (nonZero) diag_.nonZeroPackets++;
                    }
                }

                // Invoke callback
                if (!onPacket(packet)) {
                    running_.store(false);
                }

                framesCaptured += packet.frameCount;
                sequenceNumber++;

                pCaptureClient->ReleaseBuffer(numFramesAvailable);

                if (!running_.load()) break;

                // Check for more packets
                hr = pCaptureClient->GetNextPacketSize(&packetSize);
                if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
                    std::cerr << "[EndpointLoopback] Device invalidated" << std::endl;
                    deviceInvalidated = true;
                    {
                        std::lock_guard<std::mutex> lock(diagMutex_);
                        diag_.deviceInvalidations++;
                        diag_.lastHresult = hr;
                        diag_.lastError = "Device invalidated";
                    }
                    break;
                }
                if (FAILED(hr)) {
                    std::cerr << "[EndpointLoopback] GetNextPacketSize failed: "
                              << HresultToString(hr) << std::endl;
                    running_.store(false);
                    break;
                }
            }

            // Brief sleep if no data available
            if (packetSize == 0 && running_.load() && !deviceInvalidated) {
                Sleep(1);
            }
        }

        // ── Cleanup after capture loop ──
        // Stop the engine only if we still own the client and Stop() hasn't already done it
        if (pAudioClient && running_.load()) {
            pAudioClient->Stop();
        }

        SafeRelease(pCaptureClient);
        audioClient_.store(nullptr);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        // pDevice was released by InitializeWasapiEndpoint after Activate
        if (pMixFormat) {
            CoTaskMemFree(pMixFormat);
            pMixFormat = nullptr;
        }

        if (!running_.load()) break;

        // ── Device recovery ──
        if (deviceInvalidated) {
            std::cerr << "[EndpointLoopback] Attempting device recovery..." << std::endl;

            if (RecoverEndpoint()) {
                // recoverySession_ is now populated — next outer-loop iteration
                // picks it up
                continue;
            }

            // Recovery failed — exit
            std::cerr << "[EndpointLoopback] Device recovery failed, stopping" << std::endl;
            break;
        }

        // Normal exit from capture loop (running_ was set to false)
        break;
    }

    // ── Final cleanup ──
    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    // Release any leftover recovery session
    recoverySession_.Release();

    CoUninitialize();
    running_.store(false);

    std::cerr << "[EndpointLoopback] Capture thread exiting"
              << " (seq=" << sequenceNumber
              << " frames=" << framesCaptured << ")" << std::endl;
}

} // namespace screenlink::audio
