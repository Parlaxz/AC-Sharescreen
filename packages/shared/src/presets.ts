import { z } from "zod";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Preset {
  id: string;
  width: number;
  height: number;
  captureFps: number;
  videoCeilingKbps: number;
  policyMaximumKbps: number;
  audio: boolean;
  contentHint: "detail" | "motion";
  degradationPreference: "maintain-resolution" | "maintain-framerate" | "balanced";
  default?: boolean;
}

// ─── Presets ───────────────────────────────────────────────────────────────

export const PRESETS: Preset[] = [
  {
    id: "egypt-ultra-saver",
    width: 640,
    height: 360,
    captureFps: 10,
    videoCeilingKbps: 300,
    policyMaximumKbps: 400,
    audio: false,
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
  },
  {
    id: "egypt-data-saver",
    default: true,
    width: 854,
    height: 480,
    captureFps: 15,
    videoCeilingKbps: 650,
    policyMaximumKbps: 800,
    audio: false,
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
  },
  {
    id: "text-and-coding",
    width: 854,
    height: 480,
    captureFps: 10,
    videoCeilingKbps: 450,
    policyMaximumKbps: 600,
    audio: false,
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
  },
  {
    id: "balanced",
    width: 1280,
    height: 720,
    captureFps: 30,
    videoCeilingKbps: 1800,
    policyMaximumKbps: 2500,
    audio: true,
    contentHint: "detail",
    degradationPreference: "balanced",
  },
  {
    id: "smooth-motion",
    width: 1280,
    height: 720,
    captureFps: 60,
    videoCeilingKbps: 5000,
    policyMaximumKbps: 7000,
    audio: true,
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function getDefaultPreset(): Preset {
  return PRESETS.find((p) => p.default) ?? PRESETS[0]!;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const CUSTOM_RANGE = {
  width: { min: 320, max: 3840 },
  height: { min: 180, max: 2160 },
  captureFps: { min: 1, max: 60 },
  perViewerMaxFps: { min: 1, max: 60 },
  videoCeilingKbps: { min: 100, max: 20000 },
  audioBitrate: { min: 16, max: 256 },
} as const;

// ─── Zod Schema ────────────────────────────────────────────────────────────

export const PresetSchema = z.object({
  id: z.string(),
  width: z
    .number()
    .int()
    .min(CUSTOM_RANGE.width.min)
    .max(CUSTOM_RANGE.width.max),
  height: z
    .number()
    .int()
    .min(CUSTOM_RANGE.height.min)
    .max(CUSTOM_RANGE.height.max),
  captureFps: z
    .number()
    .int()
    .min(CUSTOM_RANGE.captureFps.min)
    .max(CUSTOM_RANGE.captureFps.max),
  videoCeilingKbps: z
    .number()
    .int()
    .min(CUSTOM_RANGE.videoCeilingKbps.min)
    .max(CUSTOM_RANGE.videoCeilingKbps.max),
  policyMaximumKbps: z.number().int().positive(),
  audio: z.boolean(),
  contentHint: z.enum(["detail", "motion"]),
  degradationPreference: z.enum([
    "maintain-resolution",
    "maintain-framerate",
    "balanced",
  ]),
  default: z.boolean().optional(),
});

export type PresetParsed = z.infer<typeof PresetSchema>;
