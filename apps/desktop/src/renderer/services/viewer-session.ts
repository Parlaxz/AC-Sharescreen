import { ViewerClient } from "@screenlink/vdo-adapter";
import { getRuntime } from "./phase3-runtime.js";
import type { Phase3Runtime } from "./phase3-runtime.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Minimal event surface of ViewerClient needed for the join flow.
 * The @screenlink/vdo-adapter does not export a public interface for
 * these SDK-level events, so we scope the unknown cast to this one
 * local helper rather than repeating it at every call site.
 */
interface ViewerClientEvents {
  on(event: "track", listener: (track: MediaStreamTrack, stream: MediaStream) => void): void;
  on(event: "remoteAdded", listener: () => void): void;
}

function asEventTarget(vc: ViewerClient): ViewerClientEvents {
  return vc as unknown as ViewerClientEvents;
}

export type ViewerSessionState =
  | "idle"
  | "connecting"
  | "requesting-join"
  | "waiting-for-host"
  | "accepted"
  | "connecting-media"
  | "watching"
  | "ended"
  | "error";

export interface ViewerSessionOptions {
  groupId: string;
  hostDeviceId: string;
  logicalStreamId: string;
  mediaSessionId: string;
  hostName: string;
  videoElement?: HTMLVideoElement | null;
}

export interface ViewerSessionEvents {
  onStateChange?: (state: ViewerSessionState) => void;
  onStreamReceived?: (stream: MediaStream) => void;
  onError?: (error: string) => void;
}

// ─── ViewerSession ─────────────────────────────────────────────────────────

/**
 * ViewerSession — owns one active viewer watch session.
 *
 * Lifecycle:
 *   start()  → "connecting" → "requesting-join" → "waiting-for-host"
 *            → "accepted" → "connecting-media" → "watching"
 *            → or "error" at any point
 *   stop()   → cleanup → "ended"
 *   retry()  → run the full join flow again
 *   destroy()→ final cleanup, no further use
 *
 * The caller (typically ViewerWorkspace) binds a <video> element via
 * `bindVideoElement()`. When the remote MediaStream arrives, it is
 * automatically attached to that element.
 */
export class ViewerSession {
  private _state: ViewerSessionState = "idle";
  private viewerClient: ViewerClient | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private _receivedStream: MediaStream | null = null;
  private _destructed = false;

  // Self-viewing support — when the host is the local device,
  // we pipe the capture stream directly instead of VDO relay.
  private selfViewEndedHandler: (() => void) | null = null;

  // Session identity (set by start)
  private groupId = "";
  private hostDeviceId = "";
  private logicalStreamId = "";
  private mediaSessionId = "";
  private hostName = "";

  // Events
  public onStateChange: ((state: ViewerSessionState) => void) | null = null;
  public onStreamReceived: ((stream: MediaStream) => void) | null = null;
  public onError: ((error: string) => void) | null = null;

  get state(): ViewerSessionState {
    return this._state;
  }

  get receivedStream(): MediaStream | null {
    return this._receivedStream;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Start watching a remote stream. Runs the real join flow:
   *   1) Resolve connection + host peer
   *   2) Send stream.join.request
   *   3) Wait for stream.join.response
   *   4) Create ViewerClient, connect, view
   *   5) Send media.bind
   *   6) Receive media tracks
   */
  async start(options: ViewerSessionOptions): Promise<void> {
    if (this._destructed) return;
    this.groupId = options.groupId;
    this.hostDeviceId = options.hostDeviceId;
    this.logicalStreamId = options.logicalStreamId;
    this.mediaSessionId = options.mediaSessionId;
    this.hostName = options.hostName;

    if (options.videoElement) {
      this.videoElement = options.videoElement;
    }

    await this.runJoinFlow();
  }

  /**
   * Bind or rebind the video element. If a stream is already received,
   * it is immediately attached.
   */
  bindVideoElement(el: HTMLVideoElement | null): void {
    this.videoElement = el;
    if (el && this._receivedStream) {
      el.srcObject = this._receivedStream;
      el.play().catch(() => {});
    }
  }

  /**
   * Retry the full join flow. Resets state and runs start() again
   * with the same session parameters.
   */
  async retry(): Promise<void> {
    if (this._destructed) return;
    this.cleanupClient();
    this._receivedStream = null;
    await this.runJoinFlow();
  }

  /**
   * Stop watching and clean up. Idempotent.
   */
  stop(): void {
    if (this._state === "ended") return;
    this.cleanupClient();
    this._receivedStream = null;
    this.setState("ended");
  }

  /**
   * Final cleanup. The session cannot be restarted after this.
   * Idempotent.
   */
  destroy(): void {
    if (this._destructed) return;
    this._destructed = true;
    this.cleanupClient();
    this._receivedStream = null;
    this.videoElement = null;
    this._state = "ended";
    this.onStateChange = null;
    this.onStreamReceived = null;
    this.onError = null;
  }

  // ── Join flow ───────────────────────────────────────────────────────

  private async runJoinFlow(): Promise<void> {
    if (this._destructed) return;

    this.setState("requesting-join");

    try {
      const runtime = getRuntime();
      if (!runtime || runtime.isDestroyed()) {
        this.setError("runtime not initialized");
        return;
      }

      // ── Self-viewing ──────────────────────────────────────────────
      // When the host is the local device, pipe the capture stream
      // directly instead of going through the VDO relay. This lets
      // the host preview their own share in the ViewerWorkspace.
      if (this.hostDeviceId === runtime.deviceId) {
        await this.startSelfView(runtime);
        return;
      }

      const connManager = runtime.getConnectionManager();
      const conn = connManager.getConnection(this.groupId);
      if (!conn) {
        this.setError("not connected to group");
        return;
      }

      // 1) Resolve host peer
      this.setState("connecting");
      const peerUuid = conn.peerForDevice(this.hostDeviceId);
      if (!peerUuid) {
        this.setError("host not connected");
        return;
      }

      // 2) Send stream.join.request
      this.setState("requesting-join");
      const requestId = crypto.randomUUID();
      await conn.sendToPeer(peerUuid, {
        type: "stream.join.request",
        logicalStreamId: this.logicalStreamId,
        viewerDeviceId: runtime.deviceId ?? "viewer",
        viewerDisplayName: runtime.displayName ?? "Viewer",
        requestId,
      });

      // 3) Wait for stream.join.response
      this.setState("waiting-for-host");
      const response = await runtime.waitForJoinResponse(requestId, 30_000);

      if (!response.accepted) {
        this.setError(response.reason ?? "join rejected");
        return;
      }

      // 4) Extract credentials from response
      const joinToken = response.mediaJoinMetadata;
      const responseMediaSessionId = response.mediaSessionId ?? this.mediaSessionId;
      if (!joinToken) {
        this.setError("no join token in response");
        return;
      }

      this.setState("accepted");

      // 5) Create ViewerClient and connect
      this.setState("connecting-media");
      const viewerClient = new ViewerClient();
      this.viewerClient = viewerClient;

      // Register track event to capture the received MediaStream
      // (cast scoped to asEventTarget — single documented escape hatch)
      const events = asEventTarget(viewerClient);
      events.on("track", (track, stream) => {
        this._receivedStream = stream;
        if (this.videoElement) {
          this.videoElement.srcObject = stream;
          this.videoElement.play().catch(() => {});
        }
        this.onStreamReceived?.(stream);
        this.setState("watching");
      });

      // Also handle remoteAdded for older SDK signaling
      events.on("remoteAdded", () => {
        // Tracks arrive via the "track" event above; remoteAdded is
        // a legacy signal that the remote peer has joined the media
        // session.
      });

      // Connect to VDO — the join response should always contain the
      // host-generated VDO password.  Fall back to mediaSessionId only
      // for backward compatibility with older hosts that did not send
      // `password` in the join response.  This fallback is intentionally
      // narrow: if neither is available, createAndConnect will reject
      // and the error handler will surface the failure.
      const vdoPassword = response.password ?? responseMediaSessionId;
      await viewerClient.createAndConnect(vdoPassword);

      // View the stream
      const vdoStreamId = response.streamId ?? this.logicalStreamId;
      await viewerClient.view(vdoStreamId, runtime.displayName ?? "Viewer");

      // 6) Send media.bind
      const sdk = viewerClient.getSDK();
      if (sdk && joinToken) {
        for (const [publisherUuid] of sdk.connections) {
          try {
            await viewerClient.sendMediaBind(publisherUuid, joinToken, responseMediaSessionId);
          } catch {
            // One will succeed
          }
        }
      }

      // If media already arrived before media.bind, state is already "watching"
      if (this._state !== "watching") {
        this.setState("watching");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setError(message);
    }
  }

  /**
   * Self-viewing: host is the local device, so pipe the capture stream
   * directly to the video element instead of routing through VDO relay.
   *
   * Monitors the capture video track's "ended" event to automatically
   * transition the viewer state when the user stops sharing.
   */
  private async startSelfView(runtime: Phase3Runtime): Promise<void> {
    this.setState("connecting");

    const ssm = runtime.getStreamSessionManager();
    const captureStream = ssm.getCaptureStream();
    if (!captureStream) {
      this.setError("no local capture stream");
      return;
    }

    this._receivedStream = captureStream;
    this.onStreamReceived?.(captureStream);

    if (this.videoElement) {
      this.videoElement.srcObject = captureStream;
      this.videoElement.muted = true; // Prevent audio feedback in self-view
      await this.videoElement.play().catch(() => {});
    }

    this.setState("watching");

    // Watch for the capture track ending (user stops sharing).
    const track = captureStream.getVideoTracks()[0];
    if (track) {
      const onEnded = () => {
        track.removeEventListener("ended", onEnded);
        this.selfViewEndedHandler = null;
        this.stop();
      };
      this.selfViewEndedHandler = onEnded;
      track.addEventListener("ended", onEnded);
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private setState(state: ViewerSessionState): void {
    if (this._destructed) return;
    this._state = state;
    this.onStateChange?.(state);
  }

  private setError(error: string): void {
    if (this._destructed) return;
    this._state = "error";
    this.onStateChange?.("error");
    this.onError?.(error);
    this.cleanupClient();
  }

  private cleanupClient(): void {
    // Remove self-view track-end listener
    if (this.selfViewEndedHandler) {
      if (this._receivedStream) {
        const track = this._receivedStream.getVideoTracks()[0];
        if (track) {
          track.removeEventListener("ended", this.selfViewEndedHandler);
        }
      }
      this.selfViewEndedHandler = null;
    }

    if (this.viewerClient) {
      try {
        this.viewerClient.stopViewing().catch(() => {});
        this.viewerClient.disconnect().catch(() => {});
      } catch {
        // Ignore cleanup errors
      }
      this.viewerClient = null;
    }
    // Clear video element
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.srcObject = null;
    }
  }
}
