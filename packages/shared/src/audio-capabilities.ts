/** Result from the audio helper --capabilities command. */
export interface AudioCapabilityResult {
  protocolVersion: string;
  helperVersion: string;
  architecture: string;
  operatingSystem: string;
  osVersion: OsVersion;
  detectionMethod: string;
  detectionSucceeded: boolean;
  compiledWindowsSdkVersion: string;
  processLoopbackHeadersAvailable: boolean;
  processLoopbackRuntimeSupported: boolean;
  applicationLoopbackSupported: boolean;
  usable: boolean;
  is64BitProcess: boolean;
  is64BitOperatingSystem: boolean;
  reasonCode: string;
  reasonMessage: string;
}

export interface OsVersion {
  major: number;
  minor: number;
  build: number;
  revision: number;
}
