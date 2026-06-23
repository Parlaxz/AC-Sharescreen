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
  processLoopbackDocumentedSupported?: boolean;
  processLoopbackExperimentalCandidate?: boolean;
  processLoopbackProbed?: boolean;
  processLoopbackProbeSucceeded?: boolean;
  processLoopbackProbeFailureReason?: string;
  /** System audio (endpoint loopback) is supported on all Windows 10+ builds. */
  endpointLoopbackSupported: boolean;
  applicationLoopbackSupported: boolean;
  usable: boolean;
  is64BitProcess: boolean;
  is64BitOperatingSystem: boolean;
  osBuildExperimentalCandidate?: boolean;
  experimentalCandidate?: boolean;
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

/** Canonical ordered list of all valid AudioMode values. */
export const AUDIO_MODES: readonly AudioMode[] = [
  'none',
  'system',
  'application',
  'monitor',
  'test-tone',
] as const;

/** Returns true when `value` is one of the five canonical AudioMode literals. */
export function isAudioMode(value: unknown): value is AudioMode {
  return AUDIO_MODES.includes(value as AudioMode);
}

/**
 * Normalise an arbitrary persisted value to a valid AudioMode.
 * Any value that is not one of the five canonical literals is mapped to `'none'`.
 */
export function normalizeAudioMode(value: unknown): AudioMode {
  if (isAudioMode(value)) return value;
  return 'none';
}

export interface AudioModeInfo {
  mode: AudioMode;
  label: string;
  description: string;
  supported: boolean;
  reason?: string;
}

export function getAudioModeInfo(caps: AudioCapabilityResult | null): AudioModeInfo[] {
  const build = caps?.osVersion?.build ?? 0;
  const documented = caps?.processLoopbackDocumentedSupported === true;
  const experimental = caps?.processLoopbackExperimentalCandidate === true;
  const runtimeSupported = documented || experimental;

  return [
    { mode: 'none', label: 'No Audio', description: 'No system audio will be shared', supported: true },
    {
      mode: 'system',
      label: 'System Audio',
      description: 'Shares all sound played through your default Windows output device.',
      supported: !!caps?.endpointLoopbackSupported,
      reason: caps?.endpointLoopbackSupported ? undefined : 'System Audio requires a Windows output device',
    },
    {
      mode: 'application',
      label: 'Application Audio',
      description: runtimeSupported
        ? 'Audio from the selected application only'
        : experimental
          ? 'Application Audio runtime probe succeeded (experimental)'
          : 'Requires Windows build 20348 or newer',
      supported: !!caps?.applicationLoopbackSupported,
      reason: caps?.applicationLoopbackSupported
        ? undefined
        : caps?.reasonCode === 'experimental-probe-failed'
          ? `Application Audio probe failed on build ${build}: ${caps.reasonMessage}`
          : caps?.reasonCode === 'experimental-not-probed'
            ? `Application Audio is potentially available on build ${build} but was not probed`
            : documented
              ? 'Application Audio headers or runtime support not detected'
              : caps?.reasonCode === 'experimental-runtime-supported'
                ? ''
                : `Application Audio requires Windows build 20348 or newer (build ${build} detected)`,
    },
    {
      mode: 'monitor',
      label: 'Filtered Monitor',
      description: runtimeSupported
        ? 'Desktop audio excluding ScreenLink and configured applications'
        : experimental
          ? 'Filtered Monitor runtime probe succeeded (experimental)'
          : 'Requires Windows build 20348 or newer',
      supported: runtimeSupported,
      reason: runtimeSupported
        ? undefined
        : experimental
          ? ''
          : `Filtered Monitor requires Windows build 20348 or newer because it uses process-specific loopback capture (build ${build} detected)`,
    },
    { mode: 'test-tone', label: 'Test Tone', description: 'Diagnostic 440 Hz tone (does not capture real audio)', supported: true },
  ];
}
