#ifndef SCREENLINK_WAV_WRITER_H
#define SCREENLINK_WAV_WRITER_H

#include <cstdint>
#include <string>
#include <fstream>

namespace screenlink::audio {

/// Writes PCM audio data to a WAV file.
/// Supports 16-bit PCM and 32-bit IEEE float formats.
/// Opens, writes frames (float or int16 interleaved), then finalizes header on Close().
class WavWriter {
public:
    WavWriter() = default;
    ~WavWriter() { if (IsOpen()) Close(); }

    bool Open(const std::string& path, uint32_t sampleRate,
              uint16_t channels, uint16_t bitsPerSample);
    bool WriteFrames(const float* data, size_t frameCount);
    bool WriteFramesInt16(const int16_t* data, size_t frameCount);
    bool Close();

    bool IsOpen() const { return file_.is_open(); }
    uint64_t TotalFrames() const { return totalFrames_; }
    uint32_t DataSize() const { return dataSize_; }
    const std::string& Path() const { return path_; }

private:
    bool WriteHeader();
    bool UpdateHeader();

    std::string path_;
    std::ofstream file_;
    uint32_t sampleRate_ = 0;
    uint16_t channels_ = 0;
    uint16_t bitsPerSample_ = 0;
    uint32_t dataSize_ = 0;         // Total bytes of PCM data
    uint32_t dataSizeOffset_ = 0;   // File position of data chunk size field
    uint64_t totalFrames_ = 0;
    bool finalized_ = false;
};

} // namespace screenlink::audio

#endif // SCREENLINK_WAV_WRITER_H
