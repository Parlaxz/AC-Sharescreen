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
  /** System audio (endpoint loopback) is supported on all Windows 10+ builds. */
  endpointLoopbackSupported: boolean;
  usable: boolean;
  is64BitProcess: boolean;
  is64BitOperatingSystem: boolean;
  reasonCode: string;
  reasonMessage: string;
  status: string;
}

export interface OsVersion {
  major: number;
  minor: number;
  build: number;
  revision: number;
}

/** User-facing audio mode names and capability requirements. */
export type AudioMode = 'none' | 'system' | 'application' | 'monitor' | 'test-tone';

export interface AudioModeInfo {
  mode: AudioMode;
  label: string;
  description: string;
  supported: boolean;
  reason?: string;
}

export function getAudioModeInfo(caps: AudioCapabilityResult | null): AudioModeInfo[] {
  const build = caps?.osVersion?.build ?? 0;
  const isWin10 = caps?.operatingSystem === 'Windows' && build > 0;
  const is20348Plus = build >= 20348;

  return [
    { mode: 'none', label: 'No Audio', description: 'No system audio will be shared', supported: true },
    {
      mode: 'system',
      label: 'System Audio',
      description: 'All sound played through your default output device — works on all Windows 10+ builds',
      supported: isWin10,
      reason: isWin10 ? undefined : 'System Audio requires Windows 10 or newer',
    },
    {
      mode: 'application',
      label: 'Application Audio',
      description: 'Audio from the selected application only (requires Windows build 20348+)',
      supported: is20348Plus && !!caps?.applicationLoopbackSupported,
      reason: is20348Plus && !caps?.applicationLoopbackSupported
        ? 'Application Audio headers or runtime support not detected'
        : is20348Plus
          ? undefined
          : 'Application Audio requires Windows build 20348 or newer',
    },
    {
      mode: 'monitor',
      label: 'Filtered Monitor',
      description: 'Desktop audio excluding ScreenLink and configured applications',
      supported: is20348Plus && !!caps?.processLoopbackRuntimeSupported,
      reason: is20348Plus && !caps?.processLoopbackRuntimeSupported
        ? 'Filtered Monitor runtime support not detected'
        : is20348Plus
          ? undefined
          : 'Filtered Monitor requires Windows build 20348 or newer because it uses process-specific loopback capture',
    },
    { mode: 'test-tone', label: 'Test Tone', description: 'Diagnostic 440 Hz tone (does not capture real audio)', supported: true },
  ];
}
