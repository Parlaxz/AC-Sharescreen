/**
 * Metadata delivered to the requestVideoFrameCallback callback.
 *
 * https://wicg.github.io/video-rvfc/#videoframecallbackmetadata-dictionary
 */
interface VideoFrameCallbackMetadata {
  expectedDisplayTime: DOMHighResTimeStamp;
  height: number;
  mediaTime: number;
  presentationTime: DOMHighResTimeStamp;
  presentedFrames: number;
  processingDuration?: number;
  width: number;
  captureTime?: DOMHighResTimeStamp;
  receiveTime?: DOMHighResTimeStamp;
  rtpTimestamp?: number;
}

type VideoFrameRequestCallback = (
  now: DOMHighResTimeStamp,
  metadata: VideoFrameCallbackMetadata,
) => void;

interface HTMLVideoElement {
  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback(handle: number): void;
}

/**
 * Chrome extensions to VideoPlaybackQuality for decode timing.
 * https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediasource/video_playback_quality.idl
 */
interface VideoPlaybackQuality {
  readonly totalInterFrameDelay: number;
  readonly totalDecodeTime: number;
}
