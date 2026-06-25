export interface VDONinjaSDKConstructorOptions {
  host: string;
  password: string;
  salt: string;
  debug?: boolean;
  turnServers?: object[] | null;
  forceTURN?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  autoPingViewer?: boolean;
  autoPingInterval?: number;
}

export interface PublishOptions {
  streamID: string;
  label: string;
  password: string;
  videoCodec?: string;
  videoBitrate?: number;
  videoResolution?: {
    width: number;
    height: number;
    frameRate: number;
  };
  audioBitrate?: number;
}

export interface ViewOptions {
  audio?: boolean;
  video?: boolean;
  label?: string;
}

export interface SendDataOptions {
  uuid: string;
  type: "publisher" | "viewer";
  allowFallback: boolean;
}

export interface ConnectionEntry {
  pc: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  uuid?: string;
  streamID?: string;
}

export interface RTCRtpCodecCapabilityLike {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
}

export interface PeerGroup {
  viewer?: ConnectionEntry;
  publisher?: ConnectionEntry;
}

export interface VDONinjaSDK {
  VERSION: string;
  connections: Map<string, PeerGroup>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(stream: MediaStream, options?: PublishOptions): Promise<void>;
  stopPublishing(): Promise<void>;
  view(streamId: string, options?: ViewOptions): Promise<void>;
  stopViewing(): Promise<void>;
  sendData(payload: unknown, options: SendDataOptions): Promise<void>;
  getStats(): Promise<RTCStatsReport | undefined>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

export type SDKEvent =
  | "connected" | "disconnected" | "reconnecting" | "reconnected" | "reconnectFailed"
  | "publishing" | "publishingStopped"
  | "peerConnected" | "peerDisconnected"
  | "dataChannelOpen" | "dataChannelClose" | "dataReceived"
  | "peerInfo" | "peerLatency"
  | "track" | "trackAdded" | "trackRemoved" | "trackReplaced"
  | "connectionFailed" | "iceRestart"
  | "error" | "alert";
