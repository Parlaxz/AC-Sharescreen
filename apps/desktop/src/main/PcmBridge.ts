import { MessageChannelMain } from 'electron';
import type { ParsedPcmPacket } from './BinaryPcmParser.js';

/**
 * Sanitized PCM packet for renderer consumption.
 * No pipe names, auth tokens, or file paths.
 */
export interface RendererPcmPacket {
  streamGeneration: number;
  sequenceNumber: number;
  flags: number;
  qpcTimestamp: number;
  qpcFrequency: number;
  devicePosition: number;
  sampleRate: number;
  channels: number;
  sampleFormat: number;
  frameCount: number;
  droppedPackets: number;
  /** Float32 interleaved PCM data */
  pcmData: ArrayBuffer;
}

export interface PcmBridgeDiagnostics {
  packetsReceived: number;
  packetsForwarded: number;
  droppedNoPort: number;
  droppedWrongGeneration: number;
  postErrors: number;
  lastError: string | null;
}

export class PcmBridge {
  private port: Electron.MessagePortMain | null = null;
  private streamGeneration: number = -1;
  private packetsForwarded: number = 0;
  private diagPacketsReceived = 0;
  private diagPacketsForwarded = 0;
  private diagDroppedNoPort = 0;
  private diagDroppedWrongGeneration = 0;
  private diagPostErrors = 0;
  private diagLastError: string | null = null;

  /**
   * Transfer a MessagePort to the target WebContents for PCM delivery.
   */
  attachToWebContents(webContents: Electron.WebContents): void {
    // Close old port if any
    this.detach();

    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    this.packetsForwarded = 0;

    // Start the port
    this.port.start();

    // Post a handshake message with protocol info
    this.port.postMessage({
      type: 'pcm:handshake',
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0, // float32
      framesPerPacket: 480,
    });

    // Transfer port2 to the renderer with the expected message type
    webContents.postMessage('pcm:port', { type: 'pcm:port' }, [port2]);
  }

  /**
   * Forward a parsed PCM packet to the renderer.
   * Converts the full ParsedPcmPacket to a sanitized RendererPcmPacket.
   */
  forwardPacket(packet: ParsedPcmPacket): void {
    this.diagPacketsReceived++;

    if (!this.port) {
      this.diagDroppedNoPort++;
      return;
    }

    // Check stream generation
    if (this.streamGeneration < 0) {
      this.streamGeneration = packet.header.streamGeneration;
    } else if (packet.header.streamGeneration !== this.streamGeneration) {
      // Old generation — discard
      this.diagDroppedWrongGeneration++;
      return;
    }

    // Build sanitized packet for renderer
    const rendererPacket: RendererPcmPacket = {
      streamGeneration: packet.header.streamGeneration,
      sequenceNumber: packet.header.sequenceNumber,
      flags: packet.header.flags,
      qpcTimestamp: packet.header.qpcTimestamp,
      qpcFrequency: packet.header.qpcFrequency,
      devicePosition: packet.header.devicePosition,
      sampleRate: packet.header.sampleRate,
      channels: packet.header.channels,
      sampleFormat: packet.header.sampleFormat,
      frameCount: packet.header.frameCount,
      droppedPackets: packet.header.droppedPackets,
      pcmData: packet.payload.buffer.slice(
        packet.payload.byteOffset,
        packet.payload.byteOffset + packet.payload.byteLength,
      ) as ArrayBuffer,
    };

    // Note: Electron's MessagePortMain.postMessage does not support
    // ArrayBuffer transfers.  The pcmData ArrayBuffer arrives as a
    // structured-clone copy on the renderer side.  Zero-copy is not
    // available at this boundary.
    try {
      this.port.postMessage({
        type: 'pcm:packet',
        packet: rendererPacket,
      });

      this.packetsForwarded++;
      this.diagPacketsForwarded++;
    } catch (err) {
      this.diagPostErrors++;
      this.diagLastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Forward a stream reset signal to the renderer */
  forwardReset(newGeneration: number): void {
    this.streamGeneration = newGeneration;
    this.packetsForwarded = 0;
    if (this.port) {
      this.port.postMessage({
        type: 'pcm:reset',
        streamGeneration: newGeneration,
      });
    }
  }

  /** Detach and close the port */
  detach(): void {
    if (this.port) {
      try {
        this.port.close();
      } catch { /* ignore */ }
      this.port = null;
    }
    this.streamGeneration = -1;
    this.packetsForwarded = 0;
  }

  getDiagnostics(): PcmBridgeDiagnostics {
    return {
      packetsReceived: this.diagPacketsReceived,
      packetsForwarded: this.diagPacketsForwarded,
      droppedNoPort: this.diagDroppedNoPort,
      droppedWrongGeneration: this.diagDroppedWrongGeneration,
      postErrors: this.diagPostErrors,
      lastError: this.diagLastError,
    };
  }

  sendCanary(): void {
    if (this.port) {
      try {
        this.port.postMessage({ type: 'pcm:canary', sequence: Date.now() });
      } catch { /* canary failures are non-fatal */ }
    }
  }

  getPacketsForwarded(): number {
    return this.packetsForwarded;
  }

  isAttached(): boolean {
    return this.port !== null;
  }
}
