// SPDX-License-Identifier: MIT
/**
 * UiSoundService — singleton for UI audio cues (viewer join/leave).
 *
 * Uses a single reusable AudioContext with a dedicated GainNode.
 * Sound files are preloaded and decoded at init, then played on demand.
 * Designed to be independent from stream audio controls.
 *
 * Lifecycle:
 *   uiSoundService.preload()  → fetch + decode both WAV/MP3 files
 *   uiSoundService.play("user-join" | "user-leave") → fire-and-forget playback
 *   uiSoundService.setEnabled(false) → mute all cues
 *   uiSoundService.destroy()   → close AudioContext, free resources
 */

export type CueName = "user-join" | "user-leave";

type AudioBuffers = Partial<Record<CueName, AudioBuffer>>;

const DEFAULT_VOLUME = 0.5;
const SOUND_FILES: Record<CueName, string> = {
  "user-join": "/sounds/user-join.mp3",
  "user-leave": "/sounds/user-leave.mp3",
};

class UiSoundService {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private buffers: AudioBuffers = {};
  private enabled = true;
  private volume = DEFAULT_VOLUME;
  private preloaded = false;
  private lastPlayedCue: CueName | null = null;

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Fetch and decode both sound files. Silently handles failures so
   * a missing or corrupt sound file never interrupts the stream lifecycle.
   */
  async preload(): Promise<void> {
    if (this.preloaded) return;
    this.preloaded = true;

    const ctx = this.ensureContext();
    if (!ctx) return;

    const entries = Object.entries(SOUND_FILES) as [CueName, string][];
    const results = await Promise.allSettled(
      entries.map(async ([name, url]) => {
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          this.buffers[name] = audioBuffer;
        } catch (err) {
          console.warn(`[UiSoundService] Failed to load ${url}:`, err);
        }
      }),
    );

    // Log aggregate failures at debug level
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.debug(`[UiSoundService] ${failures.length}/${entries.length} sounds failed to load`);
    }
  }

  /**
   * Play a UI cue sound. Fire-and-forget. If the sound has not been
   * preloaded or the service is disabled, this is a no-op.
   * Prevents overlapping duplicate playback for the same lifecycle event
   * (e.g. rapid duplicate ready messages).
   */
  async play(name: CueName): Promise<void> {
    if (!this.enabled) return;

    const buffer = this.buffers[name];
    if (!buffer) return; // Not loaded or failed to decode

    // Prevent overlapping duplicate playback for same lifecycle event
    if (this.lastPlayedCue === name) return;

    const ctx = this.ensureContext();
    if (!ctx) return;

    // Resume context if suspended (user gesture requirement)
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        return; // Can't play — context remains suspended
      }
    }

    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain!);
      source.start();
      this.lastPlayedCue = name;

      // Reset the overlap guard after the sound duration
      const durationMs = (buffer.duration + 0.1) * 1000;
      setTimeout(() => {
        if (this.lastPlayedCue === name) {
          this.lastPlayedCue = null;
        }
      }, durationMs);
    } catch {
      // Never throw into stream lifecycle
    }
  }

  /**
   * Enable or disable all UI sounds.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Set the output volume. Clamped to [0, 1].
   * Lazily creates the AudioContext if not yet initialised.
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    const ctx = this.ensureContext();
    if (ctx && this.gain) {
      this.gain.gain.value = this.volume;
    }
  }

  /**
   * Destroy the service and release all resources. The service
   * cannot be used after this call. Safe to call multiple times.
   */
  async destroy(): Promise<void> {
    this.buffers = {};
    this.lastPlayedCue = null;
    this.enabled = false;

    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        // Best effort
      }
      this.ctx = null;
      this.gain = null;
    }
  }

  // ─── Internal ───────────────────────────────────────────────────

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;

    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      gain.connect(ctx.destination);
      this.ctx = ctx;
      this.gain = gain;
      return ctx;
    } catch {
      // AudioContext may not be available (SSR, restricted environments)
      return null;
    }
  }
}

/**
 * Singleton instance for the entire renderer process.
 */
export const uiSoundService = new UiSoundService();
