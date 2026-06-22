#ifndef SCREENLINK_PIPE_TRANSPORT_H
#define SCREENLINK_PIPE_TRANSPORT_H

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace screenlink::audio {

// ── Wire format constants ──

constexpr uint32_t kPcmMagic = 0x50434D21;      // "PCM!" in little-endian
constexpr uint16_t kPcmWireVersion = 1;
constexpr size_t kPcmDefaultQueueSize = 128;     // ~1.28s at 10ms packets

constexpr uint32_t kMaxPcmFramesPerPacket = 960; // 20ms at 48kHz
constexpr uint32_t kMaxPcmFrameBytes = kMaxPcmFramesPerPacket * 2 * sizeof(float); // 7680

// ── PcmPacketFlags ──

enum PcmPacketFlags : uint32_t {
    kPcmFlagSilent         = 1,
    kPcmFlagDiscontinuity  = 2,
    kPcmFlagTimestampError = 4,
    kPcmFlagSynthetic      = 8,
    kPcmFlagEndOfStream    = 16,
};

// ── Packed wire header (48-byte nominal wire layout) ──

#pragma pack(push, 1)
struct PcmPacketHeader {
    uint32_t magic              = kPcmMagic;
    uint16_t headerSize         = sizeof(PcmPacketHeader);
    uint16_t wireVersion        = kPcmWireVersion;
    uint32_t flags              = 0;
    uint64_t sequenceNumber     = 0;
    uint64_t qpcTimestamp       = 0;
    uint64_t qpcFrequency       = 0;
    uint64_t devicePosition     = 0;
    uint32_t sampleRate         = 48000;
    uint16_t channels           = 2;
    uint16_t sampleFormat       = 0;  // 0 = IEEE float32
    uint32_t frameCount         = 0;
    uint32_t payloadBytes       = 0;
    uint32_t streamGeneration   = 0;
    uint32_t droppedPackets     = 0;
};
#pragma pack(pop)

// Sanity check: ensure packing works as expected on MSVC x64.
// The actual packed size is the sum of all member sizes since there is no padding
// with #pragma pack(1). Each field contributes:
//   4+2+2+4 + 8+8+8+8 + 4+2+2+4+4+4+4 = 68 bytes
static_assert(sizeof(PcmPacketHeader) == 68,
              "PcmPacketHeader packed size must be 68 bytes");

constexpr uint32_t kMaxPcmPacketBytes =
    sizeof(PcmPacketHeader) + kMaxPcmFrameBytes;  // 68 + 7680 = 7748

// ── PcmPacket ──

struct PcmPacket {
    PcmPacketHeader header = {};
    std::vector<float> payload;  // interleaved float32 samples
};

// ── Bounded SPSC queue ──

class PcmPacketQueue {
public:
    explicit PcmPacketQueue(size_t maxPackets);
    ~PcmPacketQueue() = default;

    // Producer: returns false if queue is full (packet dropped).
    bool TryPush(PcmPacket packet);

    // Consumer: returns false if queue is empty.
    bool TryPop(PcmPacket& packet);

    size_t Size() const;          // approximate number of queued packets
    size_t MaxSize() const;       // capacity
    uint32_t DroppedCount() const; // total dropped since creation or last Reset
    void Reset();                 // clear queue and reset counters

private:
    size_t Next(size_t index) const { return (index + 1) % maxPackets_; }

    std::vector<PcmPacket> buffer_;
    size_t maxPackets_ = 0;

    // Producer writes at tail_, consumer reads from head_.
    // Queue is full when Next(tail_) == head_.
    // Queue is empty when head_ == tail_.
    std::atomic<size_t> head_{0};
    std::atomic<size_t> tail_{0};

    std::atomic<uint32_t> droppedCount_{0};
};

// ── Header validation ──

struct PcmHeaderParseResult {
    bool valid = false;
    std::string error;
};

/// Validates a PcmPacketHeader for wire-format correctness.
PcmHeaderParseResult ValidatePcmHeader(const PcmPacketHeader& header);

// ── PCM named-pipe writer ──

class PcmPipeWriter {
public:
    PcmPipeWriter() = default;
    ~PcmPipeWriter();

    /// Create named-pipe server on `pipeName` and start the writer thread.
    /// pipeName should be like "\\\\.\\pipe\\screenlink-{session}-pcm"
    bool Start(const std::string& pipeName);

    /// Signal the writer thread to stop and close the pipe.
    void Stop();

    bool IsRunning() const { return running_.load(); }

    PcmPacketQueue& Queue() { return queue_; }
    size_t PacketsWritten() const { return packetsWritten_.load(); }
    size_t WriteErrors() const { return writeErrors_.load(); }

private:
    void ThreadFunc();

    static constexpr uint32_t kConnectTimeoutMs = 5000;

    std::string pipeName_;
    void* pipe_ = nullptr;
    std::thread thread_;
    std::atomic<bool> running_{false};
    mutable std::mutex mutex_;  // protects pipe_ during Start/Stop/ThreadFunc
    std::atomic<size_t> packetsWritten_{0};
    std::atomic<size_t> writeErrors_{0};
    PcmPacketQueue queue_{kPcmDefaultQueueSize};
};

} // namespace screenlink::audio

#endif // SCREENLINK_PIPE_TRANSPORT_H
