import { ErrorResponseSchema } from "@screenlink/shared";
import type { SessionResponse, StartSessionRequest, HeartbeatRequest } from "@screenlink/shared";

// ─── Result types ───────────────────────────────────────────────────────────

interface RendezvousSuccess<T> {
  ok: true;
  data: T;
}

interface RendezvousFailure {
  ok: false;
  code: string;
  message: string;
}

export type RendezvousResult<T> = RendezvousSuccess<T> | RendezvousFailure;

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * HTTP client for the ScreenLink Cloudflare Worker rendezvous API.
 *
 * All methods use standard fetch (available in Electron's main process).
 * Authentication uses bearer tokens passed via the Authorization header.
 */
export class RendezvousClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async jsonRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<RendezvousResult<T>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const json = await response.json();

      if (!response.ok) {
        const error = ErrorResponseSchema.safeParse(json);
        if (error.success) {
          return {
            ok: false,
            code: error.data.error.code,
            message: error.data.error.message,
          };
        }
        return {
          ok: false,
          code: "HTTP_ERROR",
          message: `HTTP ${response.status}`,
        };
      }

      return { ok: true, data: json as T };
    } catch (err) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : "Network request failed",
      };
    }
  }

  private async emptyRequest(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<RendezvousResult<void>> {
    const result = await this.jsonRequest<Record<string, unknown>>(
      method,
      path,
      body,
      token,
    );
    if (result.ok) {
      return { ok: true, data: undefined };
    }
    return result;
  }

  // ── API methods ────────────────────────────────────────────────────────────

  /**
   * Check session status as a viewer.
   * Requires the viewer token (short-lived, read-only).
   */
  async getSession(
    shareId: string,
    viewerToken: string,
  ): Promise<RendezvousResult<SessionResponse>> {
    return this.jsonRequest<SessionResponse>(
      "GET",
      `/api/share/${shareId}/session`,
      undefined,
      viewerToken,
    );
  }

  /**
   * Start a new publishing session from the host.
   * Requires the host token (long-lived, write-capable).
   */
  async startSession(
    shareId: string,
    hostToken: string,
    body: StartSessionRequest,
  ): Promise<RendezvousResult<SessionResponse>> {
    return this.jsonRequest<SessionResponse>(
      "POST",
      `/api/share/${shareId}/session/start`,
      body,
      hostToken,
    );
  }

  /**
   * Send a periodic heartbeat to keep the session alive.
   */
  async sendHeartbeat(
    shareId: string,
    hostToken: string,
    body: HeartbeatRequest,
  ): Promise<RendezvousResult<SessionResponse>> {
    return this.jsonRequest<SessionResponse>(
      "POST",
      `/api/share/${shareId}/session/heartbeat`,
      body,
      hostToken,
    );
  }

  /**
   * Gracefully stop the current session.
   */
  async stopSession(
    shareId: string,
    hostToken: string,
    sessionId: string,
  ): Promise<RendezvousResult<void>> {
    return this.emptyRequest(
      "POST",
      `/api/share/${shareId}/session/stop`,
      { sessionId },
      hostToken,
    );
  }

  /**
   * Rotate the viewer token (invalidates old one, returns new one).
   */
  async rotateViewerToken(
    shareId: string,
    hostToken: string,
  ): Promise<RendezvousResult<{ viewerToken: string }>> {
    return this.jsonRequest<{ viewerToken: string }>(
      "POST",
      `/api/share/${shareId}/rotate-viewer-token`,
      undefined,
      hostToken,
    );
  }

  /**
   * Permanently delete a share and all its data.
   */
  async deleteShare(
    shareId: string,
    hostToken: string,
  ): Promise<RendezvousResult<void>> {
    return this.emptyRequest(
      "DELETE",
      `/api/share/${shareId}`,
      undefined,
      hostToken,
    );
  }
}
