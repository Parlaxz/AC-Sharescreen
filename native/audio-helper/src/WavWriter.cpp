#include "WavWriter.h"
#include <algorithm>
#include <cstring>

namespace screenlink::audio {

bool WavWriter::Open(const std::string& path, uint32_t sampleRate,
                      uint16_t channels, uint16_t bitsPerSample) {
    if (file_.is_open()) {
        return false;
    }

    // Validate parameters
    if (sampleRate == 0 || channels == 0 ||
        (bitsPerSample != 16 && bitsPerSample != 32)) {
        return false;
    }

    path_ = path;
    sampleRate_ = sampleRate;
    channels_ = channels;
    bitsPerSample_ = bitsPerSample;
    totalFrames_ = 0;
    dataSize_ = 0;
    finalized_ = false;

    file_.open(path, std::ios::binary | std::ios::out);
    if (!file_.is_open()) {
        return false;
    }

    return WriteHeader();
}

bool WavWriter::WriteHeader() {
    // Determine audio format: 1 = PCM (int16), 3 = IEEE_FLOAT (float32)
    uint16_t audioFormat = (bitsPerSample_ == 32) ? 3 : 1;
    uint16_t blockAlign = static_cast<uint16_t>(channels_ * (bitsPerSample_ / 8));
    uint32_t byteRate = sampleRate_ * blockAlign;

    // Write RIFF header (44 bytes total)
    // Offset 0: 'RIFF'
    file_.write("RIFF", 4);
    if (!file_.good()) return false;

    // Offset 4: RIFF size (placeholder, updated on Close)
    uint32_t riffSize = 0xFFFFFFFF;
    file_.write(reinterpret_cast<const char*>(&riffSize), 4);
    if (!file_.good()) return false;

    // Offset 8: 'WAVE'
    file_.write("WAVE", 4);
    if (!file_.good()) return false;

    // Offset 12: 'fmt ' subchunk
    file_.write("fmt ", 4);
    if (!file_.good()) return false;

    // Offset 16: fmt chunk size (16 for PCM)
    uint32_t fmtChunkSize = 16;
    file_.write(reinterpret_cast<const char*>(&fmtChunkSize), 4);
    if (!file_.good()) return false;

    // Offset 20: audio format
    file_.write(reinterpret_cast<const char*>(&audioFormat), 2);
    if (!file_.good()) return false;

    // Offset 22: number of channels
    file_.write(reinterpret_cast<const char*>(&channels_), 2);
    if (!file_.good()) return false;

    // Offset 24: sample rate
    file_.write(reinterpret_cast<const char*>(&sampleRate_), 4);
    if (!file_.good()) return false;

    // Offset 28: byte rate
    file_.write(reinterpret_cast<const char*>(&byteRate), 4);
    if (!file_.good()) return false;

    // Offset 32: block align
    file_.write(reinterpret_cast<const char*>(&blockAlign), 2);
    if (!file_.good()) return false;

    // Offset 34: bits per sample
    file_.write(reinterpret_cast<const char*>(&bitsPerSample_), 2);
    if (!file_.good()) return false;

    // Offset 36: 'data' subchunk
    file_.write("data", 4);
    if (!file_.good()) return false;

    // Offset 40: data chunk size (placeholder, recorded for later update)
    dataSizeOffset_ = static_cast<uint32_t>(file_.tellp());
    uint32_t dataChunkSize = 0;
    file_.write(reinterpret_cast<const char*>(&dataChunkSize), 4);
    if (!file_.good()) return false;

    return true;
}

bool WavWriter::WriteFrames(const float* data, size_t frameCount) {
    if (!file_.is_open() || finalized_ || data == nullptr) {
        return false;
    }

    size_t samplesPerFrame = static_cast<size_t>(channels_);
    size_t totalSamples = frameCount * samplesPerFrame;

    if (bitsPerSample_ == 32) {
        // Write float data directly
        file_.write(reinterpret_cast<const char*>(data),
                    static_cast<std::streamsize>(totalSamples * sizeof(float)));
    } else {
        // Convert float to int16
        for (size_t i = 0; i < totalSamples; ++i) {
            float sample = data[i];
            // Clamp to [-1.0, 1.0]
            if (sample > 1.0f) sample = 1.0f;
            if (sample < -1.0f) sample = -1.0f;
            int16_t pcm = static_cast<int16_t>(sample * 32767.0f);
            file_.write(reinterpret_cast<const char*>(&pcm), sizeof(int16_t));
            if (!file_.good()) {
                file_.clear();
                return false;
            }
        }
    }

    if (!file_.good()) {
        file_.clear();
        return false;
    }

    totalFrames_ += frameCount;
    return true;
}

bool WavWriter::WriteFramesInt16(const int16_t* data, size_t frameCount) {
    if (!file_.is_open() || finalized_ || data == nullptr) {
        return false;
    }

    size_t samplesPerFrame = static_cast<size_t>(channels_);
    size_t totalSamples = frameCount * samplesPerFrame;

    if (bitsPerSample_ == 16) {
        // Write int16 data directly
        file_.write(reinterpret_cast<const char*>(data),
                    static_cast<std::streamsize>(totalSamples * sizeof(int16_t)));
    } else {
        // Convert int16 to float
        for (size_t i = 0; i < totalSamples; ++i) {
            float sample = data[i] / 32768.0f;
            file_.write(reinterpret_cast<const char*>(&sample), sizeof(float));
            if (!file_.good()) {
                file_.clear();
                return false;
            }
        }
    }

    if (!file_.good()) {
        file_.clear();
        return false;
    }

    totalFrames_ += frameCount;
    return true;
}

bool WavWriter::Close() {
    if (!file_.is_open()) return false;
    if (finalized_) return true;

    file_.flush();

    // Calculate actual data size
    dataSize_ = static_cast<uint32_t>(
        totalFrames_ * static_cast<uint64_t>(channels_) * (bitsPerSample_ / 8));

    // Update data chunk size at offset 40
    file_.seekp(static_cast<std::streamoff>(dataSizeOffset_));
    if (!file_.good()) {
        file_.clear();
        file_.close();
        finalized_ = true;
        return false;
    }
    file_.write(reinterpret_cast<const char*>(&dataSize_), 4);
    if (!file_.good()) {
        file_.clear();
        file_.close();
        finalized_ = true;
        return false;
    }

    // Update RIFF size at offset 4 (36 bytes header + data size)
    uint32_t riffSize = 36 + dataSize_;
    file_.seekp(4);
    if (!file_.good()) {
        file_.clear();
        file_.close();
        finalized_ = true;
        return false;
    }
    file_.write(reinterpret_cast<const char*>(&riffSize), 4);

    bool ok = file_.good();
    file_.close();
    finalized_ = true;

    if (!ok) {
        file_.clear();
        return false;
    }

    return true;
}

} // namespace screenlink::audio
