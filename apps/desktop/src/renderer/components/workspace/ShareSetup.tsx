import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Monitor,
  VolumeX,
  Volume2,
  Headphones,
  RefreshCw,
  AlertTriangle,
  Info,
  Check,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  useStore,
  type Page,
} from "@/stores/main-store";
import { startShare } from "@/services/share-coordinator";
import {
  customPresetToOverride,
  presetSettingsToOverride,
  type SessionQualityOverride,
} from "@/services/share-quality";
import { fetchQualityPresets } from "@/services/group-actions";
import type { CaptureSourceDTO } from "../../../preload/api-types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

type SourceTab = "screen" | "window";

type AudioModeValue = "none" | "monitor" | "application";

/**
 * Resolve the user's selected preset + custom slider values into a
 * SessionQualityOverride. Returns null when no preset is selected.
 */
function resolveSelectedQualityOverride(args: {
  selectedPresetId: string | null;
  presets: Array<{ id: string; settings: unknown }>;
  customWidth: number;
  customHeight: number;
  customFps: number;
  customBitrate: number;
}): SessionQualityOverride | null {
  const {
    selectedPresetId,
    presets,
    customWidth,
    customHeight,
    customFps,
    customBitrate,
  } = args;
  // If a personal preset is selected, use its settings.
  if (selectedPresetId) {
    const preset = presets.find((p) => p.id === selectedPresetId);
    if (preset) {
      return presetSettingsToOverride(
        preset.settings as { video?: Record<string, unknown> } | undefined,
      );
    }
  }
  // Use Custom values when no personal preset is selected.
  return customPresetToOverride({
    width: customWidth,
    height: customHeight,
    fps: customFps,
    bitrate: customBitrate,
  });
}

/** User-facing audio mode descriptor used for radio cards. */
interface AudioModeOption {
  value: AudioModeValue;
  label: string;
  description: string;
  icon: React.ReactNode;
}

/**
 * Get audio mode options valid for the given source kind.
 * Screen: No Audio / Filtered Monitor Audio
 * Window: No Audio / Application Audio
 */
function getAudioModes(sourceKind: SourceTab): AudioModeOption[] {
  const modes: AudioModeOption[] = [
    {
      value: "none",
      label: "No audio",
      description: "No system audio will be shared",
      icon: <VolumeX className="h-4 w-4" />,
    },
  ];
  if (sourceKind === "screen") {
    modes.push({
      value: "monitor",
      label: "Filtered monitor audio",
      description:
        "Audio from your speakers/headphones, filtered to remove echo",
      icon: <Headphones className="h-4 w-4" />,
    });
  } else {
    modes.push({
      value: "application",
      label: "Application audio",
      description:
        "Captures audio from the selected source if available",
      icon: <Volume2 className="h-4 w-4" />,
    });
  }
  return modes;
}

/** Resolve the audio mode for the given source kind, falling back to stored last mode. */
function resolveAudioMode(
  sourceKind: SourceTab,
  currentAudio: AudioModeValue,
  lastScreen: "none" | "monitor",
  lastWindow: "none" | "application",
): AudioModeValue {
  const validModes: AudioModeValue[] =
    sourceKind === "screen" ? ["none", "monitor"] : ["none", "application"];
  if (validModes.includes(currentAudio)) return currentAudio;
  // Invalid for new source kind — fall back to stored default for this kind
  return sourceKind === "screen" ? lastScreen : lastWindow;
}



// ─── Helper: get preload API ───────────────────────────────────────────────

function getApi() {
  return (
    window as unknown as {
      screenlink?: import("../../../preload/api-types.js").ScreenLinkAPI;
    }
  ).screenlink;
}

// ─── Motion reduced detection ──────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

// ─── Motion transition helpers ──────────────────────────────────────────────

const springTransition = {
  type: "spring" as const,
  stiffness: 350,
  damping: 28,
};

const fadeTransition = { duration: 0.15 };

// ─── ShareSetup ────────────────────────────────────────────────────────────

/**
 * ShareSetup — Single-workspace surface for configuring a new screen share
 * (Stage 3.7D). Uses progressive disclosure (5 inline sections):
 *
 *   1. Source category    — Tabs: Screen / Window / Application
 *   2. Source selection   — Card grid with animated selection
 *   3. Audio mode         — Radio group with card visuals
 *   4. Quality preset     — Selectable cards (custom = sliders)
 *   5. Confirmation       — Button with validation
 *
 * Composed entirely from Watermelon UI primitives + framer-motion.
 * Honors prefers-reduced-motion.
 */
export function ShareSetup() {
  const reduced = usePrefersReducedMotion();

  // Store bindings
  const openShareSetup = useStore((s) => s.openShareSetup);
  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);
  const navigate = useStore((s) => s.navigate);
  const lastScreenAudioMode = useStore((s) => s.lastScreenAudioMode);
  const lastWindowAudioMode = useStore((s) => s.lastWindowAudioMode);

  // ── Form state ────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<SourceTab>("screen");
  const [sources, setSources] = useState<CaptureSourceDTO[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [audioMode, setAudioMode] = useState<AudioModeValue>(() =>
    resolveAudioMode("screen", "none", lastScreenAudioMode, lastWindowAudioMode),
  );
  const [customWidth, setCustomWidth] = useState(1280);
  const [customHeight, setCustomHeight] = useState(720);
  const [customFps, setCustomFps] = useState(24);
  const [customBitrate, setCustomBitrate] = useState(1500);
  const [startingShare, setStartingShare] = useState(false);
  // Personal presets loaded from the persistent quality-preset API.
  const [personalPresets, setPersonalPresets] = useState<
    Array<{ id: string; name: string; settings: unknown }>
  >([]);
  const [selectedPersonalPresetId, setSelectedPersonalPresetId] = useState<
    string | null
  >(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derived: sources filtered by active tab
  const filteredSources = useMemo(() => {
    return sources.filter((s) => s.kind === activeTab);
  }, [sources, activeTab]);

  // Resolve current audio mode options based on active source kind
  const audioModeOptions = useMemo(() => getAudioModes(activeTab), [activeTab]);

  // When source kind changes, reset audio if no longer valid
  useEffect(() => {
    setAudioMode((prev) =>
      resolveAudioMode(activeTab, prev, lastScreenAudioMode, lastWindowAudioMode),
    );
  }, [activeTab, lastScreenAudioMode, lastWindowAudioMode]);

  // ── Fetch sources ─────────────────────────────────────────────────────
  const fetchSources = useCallback(async () => {
    try {
      const api = getApi();
      if (!api) return;
      const list = await api.getSources();
      setSources(list);
      setSourceError(null);
    } catch (err) {
      console.error("Failed to fetch sources:", err);
      setSourceError(
        "Could not retrieve sources. Make sure screen recording is permitted.",
      );
    } finally {
      setLoadingSources(false);
    }
  }, []);

  // Poll sources every 5 seconds while open (Section 9.4)
  useEffect(() => {
    if (!openShareSetup) return;
    setLoadingSources(true);
    setSelectedSourceId(null);
    void fetchSources();
    intervalRef.current = setInterval(fetchSources, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [openShareSetup, fetchSources]);

  // Reset state on close
  useEffect(() => {
    if (!openShareSetup) {
      setActiveTab("screen");
      setSelectedSourceId(null);
      setAudioMode(resolveAudioMode("screen", "none", lastScreenAudioMode, lastWindowAudioMode));
      setSelectedPersonalPresetId(null);
      setSourceError(null);
      setStartingShare(false);
      setCustomWidth(1280);
      setCustomHeight(720);
      setCustomFps(24);
      setCustomBitrate(1500);
    }
  }, [openShareSetup]);

  // Load personal presets while the dialog is open.
  useEffect(() => {
    if (!openShareSetup) return;
    let cancelled = false;
    void fetchQualityPresets()
      .then((list) => {
        if (cancelled) return;
        setPersonalPresets(
          list.map((p) => ({ id: p.id, name: p.name, settings: p.settings })),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setPersonalPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [openShareSetup]);

  // ── Validation ─────────────────────────────────────────────────────────
  const sourceSelected = selectedSourceId !== null;
  const usingPersonalPreset = selectedPersonalPresetId !== null;
  const customValuesValid =
    customWidth >= 320 &&
    customWidth <= 3840 &&
    customHeight >= 180 &&
    customHeight <= 2160 &&
    customFps >= 1 &&
    customFps <= 60 &&
    customBitrate >= 100 &&
    customBitrate <= 20000;
  // When a personal preset is selected, Custom slider values are irrelevant.
  // Only validate Custom sliders when no personal preset is active.
  const canStart = sourceSelected && (usingPersonalPreset || customValuesValid);

  // ── Start sharing ──────────────────────────────────────────────────────
  const handleStartSharing = useCallback(async () => {
    if (!canStart || startingShare) return;
    setStartingShare(true);

    try {
      const source = sources.find((s) => s.id === selectedSourceId);
      if (!source) {
        toast.error("Sharing failed: source not found");
        setStartingShare(false);
        return;
      }

      const groupId = useStore.getState().selectedGroupId;
      if (!groupId) {
        toast.error("Sharing failed: no group selected");
        setStartingShare(false);
        return;
      }

      const qualityOverride = resolveSelectedQualityOverride({
        selectedPresetId: selectedPersonalPresetId,
        presets: personalPresets,
        customWidth,
        customHeight,
        customFps,
        customBitrate,
      });

      // Start the real stream via the coordinator (uses SSM internally).
      // Explicit groupId + qualityOverride mean the coordinator never
      // has to discover values from the store.
      await startShare({
        groupId,
        source: {
          id: source.id,
          name: source.name,
          kind: source.kind,
          displayId: source.displayId ?? null,
          fingerprint: null,
          audioMode: audioMode === "none" ? "none" : audioMode,
        },
        qualityOverride: qualityOverride ?? undefined,
      });

      // Persist source selection
      const api = getApi();
      if (api) {
        await api.updateSettings({
          lastSourceId: source.id,
          lastSourceName: source.name,
        });
      }

      toast.success("Sharing started");
      setOpenShareSetup(false);
      navigate("host" as Page);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      toast.error(`Sharing failed: ${message}`);
    } finally {
      setStartingShare(false);
    }
  }, [
    canStart,
    startingShare,
    sources,
    selectedSourceId,
    selectedPersonalPresetId,
    personalPresets,
    customWidth,
    customHeight,
    customFps,
    customBitrate,
    setOpenShareSetup,
    navigate,
    audioMode,
    audioModeOptions,
    lastScreenAudioMode,
    lastWindowAudioMode,
  ]);

  // ── Render ─────────────────────────────────────────────────────────────
  const transitionProps = reduced
    ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: fadeTransition }
    : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 }, transition: springTransition };

  return (
    <Dialog open={openShareSetup} onOpenChange={setOpenShareSetup}>
      <DialogContent className="max-w-2xl max-h-[85vh] p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>Start sharing</DialogTitle>
          <DialogDescription>
            Configure your share source, audio, and quality settings.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(85vh-120px)] px-6 pb-6">
          <div className="space-y-6">
            {/* ─── Section 1: Source category (tabs) ─────────────────── */}
            <section>
              <h3 className="text-sm font-medium text-text-primary mb-3">
                Source type
              </h3>
              <Tabs
                value={activeTab}
                onValueChange={(v) => setActiveTab(v as SourceTab)}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="screen" className="flex-1 gap-1.5">
                    <Monitor className="h-3.5 w-3.5" />
                    Screen
                  </TabsTrigger>
                  <TabsTrigger value="window" className="flex-1 gap-1.5">
                    <Monitor className="h-3.5 w-3.5" />
                    Window
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </section>

            {/* ─── Section 2: Source selection ───────────────────────── */}
            <section>
              <h3 className="text-sm font-medium text-text-primary mb-3">
                Select source
              </h3>

              <AnimatePresence mode="wait">
                {loadingSources && filteredSources.length === 0 ? (
                  <motion.div
                    key="loading"
                    {...transitionProps}
                    className="grid grid-cols-2 sm:grid-cols-3 gap-3"
                  >
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="space-y-2">
                        <Skeleton className="aspect-video w-full rounded-standard" />
                        <Skeleton className="h-4 w-20" />
                      </div>
                    ))}
                  </motion.div>
                ) : sourceError && filteredSources.length === 0 ? (
                  <motion.div key="error" {...transitionProps}>
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Source error</AlertTitle>
                      <AlertDescription>{sourceError}</AlertDescription>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() => {
                          setLoadingSources(true);
                          setSourceError(null);
                          void fetchSources();
                        }}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Retry
                      </Button>
                    </Alert>
                  </motion.div>
                ) : filteredSources.length === 0 ? (
                  <motion.div key="empty" {...transitionProps}>
                    <Alert variant="default">
                      <Info className="h-4 w-4" />
                      <AlertTitle>No sources found</AlertTitle>
                      <AlertDescription>
                        {activeTab === "screen"
                          ? "No screens detected. Make sure screen recording is permitted."
                          : "No windows available to share."}
                      </AlertDescription>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() => {
                          setLoadingSources(true);
                          void fetchSources();
                        }}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Refresh
                      </Button>
                    </Alert>
                  </motion.div>
                ) : (
                  <motion.div
                    key="sources"
                    {...transitionProps}
                    className="grid grid-cols-2 sm:grid-cols-3 gap-3"
                  >
                    {filteredSources.map((src) => {
                      const isSelected = selectedSourceId === src.id;
                      return (
                        <motion.div
                          key={src.id}
                          layout={reduced ? false : true}
                          transition={springTransition}
                        >
                          <Card
                            className={cn(
                              "cursor-pointer overflow-hidden transition-colors hover:bg-surface-hover relative",
                              isSelected &&
                                "ring-2 ring-accent bg-accent-muted/30",
                            )}
                            onClick={() => setSelectedSourceId(src.id)}
                            role="radio"
                            aria-checked={isSelected}
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelectedSourceId(src.id);
                              }
                            }}
                          >
                            {/* Thumbnail */}
                            <div className="aspect-video relative bg-surface-3 overflow-hidden">
                              {src.thumbnailDataUrl ? (
                                <img
                                  src={src.thumbnailDataUrl}
                                  alt={src.name}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <Monitor className="h-8 w-8 text-text-muted" />
                                </div>
                              )}

                              {/* Selected indicator with layoutId animation */}
                              {isSelected && (
                                <motion.div
                                  layoutId={`source-check-${activeTab}`}
                                  initial={reduced ? false : { scale: 0 }}
                                  animate={{ scale: 1 }}
                                  transition={springTransition}
                                  className="absolute top-2 right-2 h-5 w-5 rounded-full bg-accent flex items-center justify-center"
                                >
                                  <Check className="h-3 w-3 text-white" />
                                </motion.div>
                              )}
                            </div>

                            {/* Source name */}
                            <CardContent className="p-2">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <p className="text-xs font-medium text-text-primary truncate">
                                    {src.name}
                                  </p>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                  {src.name}
                                </TooltipContent>
                              </Tooltip>
                            </CardContent>
                          </Card>
                        </motion.div>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            {/* ─── Section 3: Audio mode ─────────────────────────────── */}
            <section>
              <h3 className="text-sm font-medium text-text-primary mb-3">
                Audio mode
              </h3>
              <RadioGroup
                value={audioMode}
                onValueChange={(v) => setAudioMode(v as AudioModeValue)}
                className="grid grid-cols-1 sm:grid-cols-2 gap-2"
              >
                {audioModeOptions.map((mode) => {
                  const isSelected = audioMode === mode.value;
                  return (
                    <label
                      key={mode.value}
                      className={cn(
                        "relative flex items-start gap-3 rounded-standard border p-3 cursor-pointer transition-colors",
                        isSelected
                          ? "border-accent bg-accent-muted/20 ring-1 ring-accent"
                          : "border-border-subtle bg-surface-2 hover:bg-surface-hover",
                      )}
                    >
                      <RadioGroupItem
                        value={mode.value}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-text-primary text-sm font-medium">
                          {mode.label}
                        </span>
                        <p className="text-xs text-text-secondary mt-0.5">
                          {mode.description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </RadioGroup>
            </section>

            {/* ─── Section 4: Quality preset ─────────────────────────── */}
            <section>
              <h3 className="text-sm font-medium text-text-primary mb-3">
                Quality settings
              </h3>

              {/* Personal preset selector + Custom as default option */}
              <div className="space-y-1.5 mb-4">
                <Label className="text-xs text-text-secondary">
                  Personal preset (optional — uses Custom when none selected)
                </Label>
                <Select
                  value={selectedPersonalPresetId ?? "__none__"}
                  onValueChange={(v) => {
                    if (v === "__none__") {
                      setSelectedPersonalPresetId(null);
                      return;
                    }
                    setSelectedPersonalPresetId(v);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Custom (no preset)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Custom</SelectItem>
                    {personalPresets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Custom quality settings (always visible, dimmed when personal preset active) */}
              <Card
                className={cn(
                  selectedPersonalPresetId ? "opacity-50 pointer-events-none" : "border-accent/30",
                )}
              >
                <CardContent className="p-4 space-y-4">
                  <h4 className="text-sm font-medium text-text-primary">
                    Custom quality settings
                  </h4>

                  {/* Width/Height in a row */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-text-secondary">Width</Label>
                        <span className="text-xs font-mono tabular-nums text-text-primary">
                          {customWidth}px
                        </span>
                      </div>
                      <Slider
                        value={[customWidth]}
                        onValueChange={([v]) => setCustomWidth(v ?? 1280)}
                        min={320}
                        max={3840}
                        step={8}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-text-secondary">Height</Label>
                        <span className="text-xs font-mono tabular-nums text-text-primary">
                          {customHeight}px
                        </span>
                      </div>
                      <Slider
                        value={[customHeight]}
                        onValueChange={([v]) => setCustomHeight(v ?? 720)}
                        min={180}
                        max={2160}
                        step={8}
                      />
                    </div>
                  </div>

                  {/* FPS slider */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-text-secondary">Frame rate</Label>
                      <span className="text-xs font-mono tabular-nums text-text-primary">
                        {customFps} fps
                      </span>
                    </div>
                    <Slider
                      value={[customFps]}
                      onValueChange={([v]) => setCustomFps(v ?? 24)}
                      min={1}
                      max={60}
                      step={1}
                    />
                  </div>

                  {/* Bitrate slider */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-text-secondary">Bitrate</Label>
                      <span className="text-xs font-mono tabular-nums text-text-primary">
                        {customBitrate} kbps
                      </span>
                    </div>
                    <Slider
                      value={[customBitrate]}
                      onValueChange={([v]) => setCustomBitrate(v ?? 1500)}
                      min={100}
                      max={20000}
                      step={50}
                    />
                  </div>

                  {!usingPersonalPreset && !customValuesValid && (
                    <Alert variant="warning" className="py-2">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle className="text-xs">Value out of range</AlertTitle>
                      <AlertDescription className="text-xs">
                        Resolution must be 320×180–3840×2160, fps 1–60, bitrate 100–20000 kbps.
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            </section>

            {/* ─── Section 5: Confirmation ───────────────────────────── */}
            <Separator className="my-2" />

            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                {selectedSourceId && (
                  <p className="text-xs text-text-secondary">
                    Sharing{" "}
                    <span className="font-medium text-text-primary">
                      {sources.find((s) => s.id === selectedSourceId)
                        ?.name ?? "selected source"}
                    </span>
                    {audioMode !== "none" &&
                      ` with ${
                        audioModeOptions.find((m) => m.value === audioMode)
                          ?.label ?? "audio"
                      }`}
                  </p>
                )}
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button
                      variant="default"
                      disabled={!canStart || startingShare}
                      onClick={handleStartSharing}
                      className={cn(
                        "min-w-[140px] transition-opacity",
                        !canStart && "opacity-50",
                      )}
                    >
                      {startingShare ? (
                        <>
                          <motion.div
                            animate={{ rotate: 360 }}
                            transition={{
                              repeat: Infinity,
                              duration: 1,
                              ease: "linear",
                            }}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </motion.div>
                          Starting...
                        </>
                      ) : (
                        <>
                          <Monitor className="h-4 w-4" />
                          Start sharing
                        </>
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                {!canStart && (
                  <TooltipContent side="top">
                    {!sourceSelected
                      ? "Select a source to share"
                      : !usingPersonalPreset && !customValuesValid
                        ? "Fix custom quality values"
                        : ""}
                  </TooltipContent>
                )}
              </Tooltip>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
