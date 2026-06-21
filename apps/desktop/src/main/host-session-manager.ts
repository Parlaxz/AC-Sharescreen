import {
  generateSessionId,
  generateVdoStreamId,
  generateVdoPassword,
} from "@screenlink/shared";
import { RendezvousClient } from "./rendezvous-client.js";
import type { LogManager } from "./log-manager.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionConfig {
  shareId: string;
  hostToken: string;
  workerBaseUrl: string;
  width: number;
  height: number;
  fps: number;
  systemAudio: boolean;
  contentHint: "detail" | "motion";
  policy: Record<string, unknown>;
}

export interface SessionState {
  sessionId: string;
  generation: number;
  streamId: string;
  password: string;
  startedAt: number;
}

/**
 * Callbacks for session lifecycle events.
 */
export interface SessionEventCallbacks {
  onSessionLost?: () => void;
  onHeartbeatFailed?: (attempt: number) => void;
  onGenerationChanged?: (generation: number) => void;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

/**
 * Coordinates the host-side session lifecycle:
 * - Start a new publishing session via the rendezvous API
 * - Send periodic heartbeats to keep it alive
 * - Handle heartbeat failures and session expiry
 * - Gracefully stop the session
 */
export class HostSessionManager {
  private rendezvous: RendezvousClient;
  private log: LogManager;
  private config: SessionConfig | null = null;
  private state: SessionState | null = null;
  private callbacks: SessionEventCallbacks = {};
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatRetryCount = 0;
  private maxHeartbeatRetries = 3;
  private heartbeatIntervalMs = 30_000;

  constructor(rendezvous: RendezvousClient, log: LogManager) {
    this.rendezvous = rendezvous;
    this.log = log;
  }

  /**
   * Whether a session is currently active.
   */
  get isActive(): boolean {
    return this.state !== null;
  }

  /**
   * Current session state, or null if no active session.
   */
  get currentState(): SessionState | null {
    return this.state;
  }

  /**
   * Register lifecycle event callbacks.
   */
  setCallbacks(cbs: SessionEventCallbacks): void {
    this.callbacks = cbs;
  }

  /**
   * Start a new publishing session.
   *
   * Generates fresh session ID, VDO stream ID, and VDO password,
   * then registers the session with the rendezvous server.
   *
   * @throws if the rendezvous API call fails
   */
  async start(config: SessionConfig): Promise<SessionState> {
    // Stop any existing session first
    if (this.isActive) {
      await this.stop();
    }

    this.config = config;

    const sessionId = generateSessionId();
    const streamId = generateVdoStreamId();
    const password = generateVdoPassword();

    const result = await this.rendezvous.startSession(
      config.shareId,
      config.hostToken,
      {
        sessionId,
        streamId,
        password,
        startedAt: Date.now(),
        capture: {
          width: config.width,
          height: config.height,
          fps: config.fps,
          systemAudio: config.systemAudio,
          contentHint: config.contentHint,
        },
        policy: config.policy as unknown as import("@screenlink/shared").Policy,
      },
    );

    if (!result.ok) {
      throw new Error(
        `Failed to start session: [${result.code}] ${result.message}`,
      );
    }

    this.state = {
      sessionId,
      generation: result.data.session?.generation ?? 1,
      streamId,
      password,
      startedAt: Date.now(),
    };

    this.log.log("info", "session", "session_started", {
      sessionId: sessionId.slice(0, 8),
      streamId: streamId.slice(0, 8),
      generation: this.state.generation,
    });

    this.startHeartbeat();
    return this.state;
  }

  /**
   * Gracefully stop the current session.
   */
  async stop(): Promise<void> {
    if (!this.config || !this.state) return;

    this.stopHeartbeat();

    const result = await this.rendezvous.stopSession(
      this.config.shareId,
      this.config.hostToken,
      this.state.sessionId,
    );

    this.log.log("info", "session", "session_stopped", {
      sessionId: this.state.sessionId.slice(0, 8),
      generation: this.state.generation,
      ok: result.ok,
    });

    this.state = null;
    this.heartbeatRetryCount = 0;
  }

  // ── Heartbeat management ───────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => {
        // Errors are handled within sendHeartbeat
      });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.config || !this.state) return;

    const result = await this.rendezvous.sendHeartbeat(
      this.config.shareId,
      this.config.hostToken,
      {
        sessionId: this.state.sessionId,
        generation: this.state.generation,
      },
    );

    if (result.ok) {
      this.heartbeatRetryCount = 0;

      if (result.data.session) {
        const newGen = result.data.session.generation;
        if (newGen !== this.state.generation) {
          this.state.generation = newGen;
          this.callbacks.onGenerationChanged?.(newGen);
        }
      }
    } else {
      this.heartbeatRetryCount++;
      this.log.log("warn", "session", "heartbeat_failed", {
        attempt: this.heartbeatRetryCount,
        code: result.code,
        maxRetries: this.maxHeartbeatRetries,
      });

      this.callbacks.onHeartbeatFailed?.(this.heartbeatRetryCount);

      if (this.heartbeatRetryCount >= this.maxHeartbeatRetries) {
        this.log.log("error", "session", "heartbeat_max_retries_exceeded", {
          maxRetries: this.maxHeartbeatRetries,
        });
        this.stop();
        this.callbacks.onSessionLost?.();
      }
    }
  }
}
