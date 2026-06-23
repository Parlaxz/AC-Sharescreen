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

    // Check if Stop() was called during COM init
    if (!running_.load()) {
        SignalStartupComplete(EndpointStartResult::Cancelled, S_OK);
        CoUninitialize();
        return;
    }

    // ── 2. Create device enumerator ──
    IMMDeviceEnumerator* pEnumerator = nullptr;
    hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        reinterpret_cast<void**>(&pEnumerator));
    if (FAILED(hr) || !pEnumerator) {
        std::cerr << "[EndpointLoopback] CoCreateInstance(MMDeviceEnumerator) failed: "
                  << HresultToString(hr) << std::endl;
        SignalStartupComplete(EndpointStartResult::EnumeratorFailed, hr);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // ── 3. Get default render endpoint ──
    IMMDevice* pDevice = nullptr;
    hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    if (FAILED(hr) || !pDevice) {
        std::cerr << "[EndpointLoopback] GetDefaultAudioEndpoint failed: "
                  << HresultToString(hr) << std::endl;
        SignalStartupComplete(EndpointStartResult::EndpointNotFound, hr);
        SafeRelease(pEnumerator);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // ── 4. Activate IAudioClient ──
    IAudioClient* pAudioClient = nullptr;
    hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL,
                           nullptr, reinterpret_cast<void**>(&pAudioClient));
    SafeRelease(pDevice);
    if (FAILED(hr) || !pAudioClient) {
        std::cerr << "[EndpointLoopback] Activate(IAudioClient) failed: "
                  << HresultToString(hr) << std::endl;
        SignalStartupComplete(EndpointStartResult::AudioClientActivationFailed, hr);
        SafeRelease(pEnumerator);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // ── 5. Get mix format ──
    WAVEFORMATEX* pMixFormat = nullptr;
    hr = pAudioClient->GetMixFormat(&pMixFormat);
    if (FAILED(hr) || !pMixFormat) {
        std::cerr << "[EndpointLoopback] GetMixFormat failed: "
                  << HresultToString(hr) << std::endl;
        SignalStartupComplete(EndpointStartResult::GetMixFormatFailed, hr);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // ── 6. Describe source format ──
    SourceFormat srcFmt;
    srcFmt.sampleRate = pMixFormat->nSamplesPerSec;
    srcFmt.channels = pMixFormat->nChannels;
    srcFmt.bitsPerSample = pMixFormat->wBitsPerSample;
    srcFmt.isFloat = (pMixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);

    // If WAVEFORMATEXTENSIBLE, extract channel mask and subformat
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
    // For endpoint loopback, we initialize the audio client in shared mode
    // with the mix format (so it uses the engine's format), then we convert
    // on the fly in our capture loop. But we can also let the audio engine
    // do format conversion by specifying our target format.
    //
    // Approach: Use AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM with our target format,
    // so the engine converts to 48kHz stereo float32 for us.
    // This is simpler and more robust than manual conversion.

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
    // Use a 10ms buffer duration
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

        // Check for device invalidated
        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
            std::cerr << "[EndpointLoopback] Device invalidated during init" << std::endl;
        }

        SignalStartupComplete(EndpointStartResult::InitializeFailed, hr);
        CoTaskMemFree(pMixFormat);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // ── 9. Get capture client ──
    IAudioCaptureClient* pCaptureClient = nullptr;
    hr = pAudioClient->GetService(
        __uuidof(IAudioCaptureClient),
        reinterpret_cast<void**>(&pCaptureClient));
    if (FAILED(hr) || !pCaptureClient) {
        std::cerr << "[EndpointLoopback] GetService(IAudioCaptureClient) failed: "
                  << HresultToString(hr) << std::endl;
        SignalStartupComplete(EndpointStartResult::CaptureClientFailed, hr);
        CoTaskMemFree(pMixFormat);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // We now have the mix format but the audio engine will deliver data in
    // our target format (48kHz stereo float) thanks to AUTOCONVERTPCM.
    // However, GetMixFormat may give us a different format than the engine
    // uses for loopback — the engine might deliver in the ORIGINAL mix
    // format regardless of what we pass to Initialize. Let's get the actual
    // format by querying the period and testing.
    //
    // Actually, per MSDN: when using AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    // the engine converts from the mix format to our target format.
    // So we should receive data in target format (48kHz stereo float).
    //
    // To be safe, we'll also handle the case where the engine delivers
    // data in the mix format by checking the actual frame size.
    //
    // Actually, the convention is:
    // - Without AUTOCONVERTPCM: engine delivers in its internal mix format
    // - With AUTOCONVERTPCM: engine delivers in the target format we specified
    //
    // So we SHOULD get 48kHz stereo float. Let's test by getting the period.

    UINT32 bufferFrameCount = 0;
    hr = pAudioClient->GetBufferSize(&bufferFrameCount);
    if (FAILED(hr)) {
        std::cerr << "[EndpointLoopback] GetBufferSize failed: "
                  << HresultToString(hr) << std::endl;
        SignalStartupComplete(EndpointStartResult::InitializeFailed, hr);
        CoTaskMemFree(pMixFormat);
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // ── 10. Start the audio engine ──
    hr = pAudioClient->Start();
    if (FAILED(hr)) {
        std::cerr << "[EndpointLoopback] IAudioClient::Start failed: "
                  << HresultToString(hr) << std::endl;
        SignalStartupComplete(EndpointStartResult::AudioEngineStartFailed, hr);
        CoTaskMemFree(pMixFormat);
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // Check for cancellation before signaling success
    if (!running_.load()) {
        pAudioClient->Stop();
        SignalStartupComplete(EndpointStartResult::Cancelled, S_OK);
        CoTaskMemFree(pMixFormat);
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);
        SafeRelease(pEnumerator);
        CoUninitialize();
        running_.store(false);
        return;
    }

    // Make client accessible to Stop() before signaling success
    audioClient_.store(pAudioClient);
    SignalStartupComplete(EndpointStartResult::Success, S_OK);

    // ── 11. Set Pro Audio thread priority ──
    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // ── 12. Capture loop ──

    // The AUTOCONVERTPCM flag makes WASAPI convert to our target format,
    // but the actual captured format might still be the mix format because
    // loopback captures the post-mix stream. Let's figure this out correctly.
    //
    // MSDN: "A client can also use loopback mode on a render device to capture
    // the audio stream that is being played on that device."
    //
    // When we initialize with AUDCLNT_STREAMFLAGS_LOOPBACK and specify a target
    // format with AUTOCONVERTPCM, the captured data is converted to our target
    // format. So we should get 48kHz stereo float.
    //
    // But there's a catch: the loopback stream includes the audio from ALL
    // processes, already mixed by the audio engine. The format we get back
    // is the mix format of the engine (which is usually 48kHz float but could
    // have more channels).
    //
    // With AUTOCONVERTPCM, WASAPI should convert. Let's trust the flag and
    // add a safety check.

    // We assume data arrives in our target format (48kHz stereo float) thanks to
    // AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM. If the engine delivers a different format
    // despite the conversion flag, the capture loop below handles manual conversion
    // from the mix format (srcFmt) as a fallback.
    // Pre-allocate conversion buffers (member variables, reused across packets)
    conversionBuffer_.clear();
    stereoBuffer_.clear();
    resampleBuffer_.clear();

    uint64_t sequenceNumber = 0;
    uint64_t framesCaptured = 0;

    while (running_.load()) {
        // Get the next available packet size
        UINT32 packetSize = 0;
        hr = pCaptureClient->GetNextPacketSize(&packetSize);
        if (FAILED(hr)) {
            if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
                std::cerr << "[EndpointLoopback] Device invalidated — stopping" << std::endl;
            } else {
                std::cerr << "[EndpointLoopback] GetNextPacketSize failed: "
                          << HresultToString(hr) << std::endl;
            }
            break;
        }

        while (packetSize > 0) {
            BYTE* pData = nullptr;
            UINT32 numFramesAvailable = 0;
            DWORD flags = 0;
            UINT64 devicePosition = 0;
            UINT64 qpcPosition = 0;

            hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable,
                                           &flags, &devicePosition, &qpcPosition);
            if (FAILED(hr)) {
                if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
                    std::cerr << "[EndpointLoopback] Device invalidated during GetBuffer" << std::endl;
                } else {
                    std::cerr << "[EndpointLoopback] GetBuffer failed: "
                              << HresultToString(hr) << std::endl;
                }
                running_.store(false);
                break;
            }

            if (numFramesAvailable == 0) {
                pCaptureClient->ReleaseBuffer(numFramesAvailable);
                break;
            }

            // Build AudioPacket
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
            // in our target format (48 kHz stereo float).  Data is always
            // interpreted as target format when not silent.

            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
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
            if (FAILED(hr)) {
                if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
                    std::cerr << "[EndpointLoopback] Device invalidated" << std::endl;
                }
                running_.store(false);
                break;
            }
        }

        // Brief sleep if no data available
        if (packetSize == 0 && running_.load()) {
            Sleep(1);
        }
    }

    // ── 13. Stop the engine ──
    // Only stop if the control thread didn't already do it
    if (running_.load()) {
        pAudioClient->Stop();
    }

    // Revert Pro Audio priority
    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    // ── 14. Cleanup ──
    CoTaskMemFree(pMixFormat);
    SafeRelease(pCaptureClient);
    audioClient_.store(nullptr);
    SafeRelease(pAudioClient);
    SafeRelease(pEnumerator);
    CoUninitialize();

    running_.store(false);
}

} // namespace screenlink::audio
