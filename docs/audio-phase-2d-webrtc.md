# Phase 2D: AudioWorklet, MediaStream, and WebRTC Audio Publishing

**Status:** Complete
**Starting commit:** `2a20a2f` (Phase 2C final)
**Ending commits:** TBD

## Architecture

### Main-to-Renderer PCM Transport

```
AudioHelperManager (main)
  └─ BinaryPcmParser → PcmBridge
       └─ MessagePortMain → webContents.postMessage('pcm:port')
            └─ Renderer MessagePort
                 └─ ProcessAudioController → AudioWorkletNode
                      └─ MediaStreamAudioDestinationNode → MediaStreamTrack
                           └─ PublisherManager → combined MediaStream
                                └─ HostPublisher → VDO.Ninja → WebRTC
```

### MessagePort Topology

- Main process creates MessageChannelMain per renderer
- port1 retained by PcmBridge (main)
- port2 transferred to renderer via webContents.postMessage('pcm:port')
- Renderer receives port2 via window 'message' event
- ProcessAudioController stores the port and forwards packets to the worklet

### Renderer PCM Message Format

Each packet sent through the MessagePort:
```
{
  type: 'pcm:packet',
  packet: {
    streamGeneration: number,
    sequenceNumber: number,
    flags: number,
    qpcTimestamp: number,
    qpcFrequency: number,
    devicePosition: number,
    sampleRate: number,
    channels: number,
    sampleFormat: number,
    frameCount: number,
    droppedPackets: number,
    pcmData: ArrayBuffer  // Float32Array transferred
  }
}
```

No pipe names, auth tokens, or file paths are exposed to the renderer.

### AudioWorklet Processor

- File: `process-pcm-worklet.ts`
- Self-contained (no AudioWorklet scope imports)
- Inline ring buffer (8192 frames = ~170ms)
- Target priming: 3840 frames = ~80ms
- process() allocation-free, never throws
- Converts interleaved input to planar output for Web Audio

### Ring Buffer

- File: `PcmRingBuffer.ts`
- Bounded: 8192 frames at 48kHz, 2 channels
- Drop-oldest on overrun: newest samples preserved
- Underrun: zero-fill output, increment counter
- Single producer (MessagePort handler), single consumer (worklet process())

### Priming Threshold

- Target: 3840 frames (~80ms at 48kHz)
- Timeout: 5000ms
- Worklet sends 'pcm:primed' message when threshold reached
- Controller transitions from 'buffering' to 'primed'

### Underrun Behavior

When the ring buffer has insufficient data:
- Output is zero-filled for the current render quantum
- underrunFrames counter is incremented
- No old samples are replayed
- No audio thread blocking occurs

### Overrun Behavior

When the ring buffer exceeds capacity:
- Oldest frames are dropped from the buffer
- overrunFrames counter is incremented
- Newest frames are always preserved

### Discontinuity Behavior

The worklet receives discontinuity signals from:
- Source-side deadline misses (marked in AudioPacket/C++ source)
- Stream generation changes
- Ring buffer overrun recovery

Discontinuities increment the worklet's discontinuity counter.

### AudioContext

- sampleRate: 48000 (verified after creation, non-48kHz returns error)
- latencyHint: 'interactive'
- Created/resumed on user gesture (Share action)
- AudioContext.destination is NOT connected — no local playback
- Only connects: worklet → MediaStreamAudioDestinationNode

### Combined Stream Lifecycle

1. PublisherManager.startCapture() gets display stream
2. ProcessAudioController creates AudioContext + worklet + track
3. PublisherManager.setAudioController(controller) sets the audio source
4. PublisherManager.startPublishing() builds combined MediaStream from video + audio tracks
5. HostPublisher publishes the combined stream via VDO.Ninja
6. stopCapture() closes AudioContext, stops tracks, stops publisher

### Remote Playback

- Remote stream now includes both video and audio tracks
- Existing video element plays both (autoplay)
- Local mute button sets video.muted
- Local volume slider sets video.volume
- Autoplay rejection: "Enable Audio" button calls video.play()

### WebRTC Audio Statistics

Separate audio stats in MediaStatsSnapshot:
- Outbound: bytesSent, packetsSent, bitrate, codec, SSRC
- Inbound: bytesReceived, packetsReceived, bitrate, packetsLost, jitter, concealedSamples
- Calculated from WebRTC getStats() audio outbound-rtp and inbound-rtp entries

### Synthetic Audio Sharing (Development)

A "Share with Audio (Dev)" button triggers:
1. IPC start-synthetic-audio → AudioHelperManager starts helper
2. IPC request-audio-port → PcmBridge transfers MessagePort
3. Renderer ProcessAudioController initializes AudioContext + worklet
4. PublisherManager combines audio track with display video
5. Combined stream published via VDO.Ninja

### Test Commands

```
# Build + unit tests
pnpm audio-helper:check
pnpm test

# Audio ring buffer tests
pnpx vitest run apps/desktop/tests/pcm-ring-buffer.test.ts

# All desktop tests
pnpx vitest run apps/desktop/tests/

# Audio worklet static tests
pnpx vitest run apps/desktop/tests/audio-worklet-static.test.ts

# 30-minute stability test
node apps/desktop/scripts/transport-stability.mjs 30
```

### Cleanup Order

1. Stop accepting new PCM packets
2. Close renderer MessagePort (port.close())
3. Disconnect worklet node
4. Disconnect MediaStreamDestinationNode
5. Close AudioContext and await completion
6. Release ProcessAudioController references
7. Remove or stop audio sender via HostPublisher
8. Stop video track
9. Stop publisher
10. Shut down helper via AudioHelperManager.shutdown()

All steps are idempotent.

### Limitations

- Real process-loopback capture is still unverified on build 19045
- Application-only audio is not yet proven
- Discord exclusion is not implemented yet
- The multi-application mixer is not implemented yet
- Groups and group-controlled stream quality are not implemented yet
- AudioWorklet runs at 48kHz only (non-48kHz contexts return error)
- No resampling implemented yet
- Audio replacement during an active share requires re-publishing
