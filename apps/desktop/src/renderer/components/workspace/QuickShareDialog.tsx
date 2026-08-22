import { useState, useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  Monitor,
  VolumeX,
  Headphones,
  Volume2,
  Users,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/stores/main-store";
import { startShare, type ShareSource } from "@/services/share-coordinator";
import {
  customPresetToOverride,
  presetSettingsToOverride,
  deriveSourceErrorText,
  resolveAudioMode,
  type AudioModeValue,
  type SessionQualityOverride,
} from "@/services/share-quality";
import { fetchQualityPresets } from "@/services/group-actions";
import type { QuickShareConfigDTO, CaptureSourceDTO } from "../../../preload/api-types.js";

// ─── Custom default values (module-scope constants, aligned with ShareSetup) ──
const CUSTOM_DEFAULT_WIDTH = 1280;
const CUSTOM_DEFAULT_HEIGHT = 720;
const CUSTOM_DEFAULT_FPS = 24;
const CUSTOM_DEFAULT_BITRATE_KBPS = 1500;

// ─── Preload API accessor ────────────────────────────────────────────────

function getApi() {
  try {
    return (
      window as unknown as {
        screenlink?: {
          getQuickShareConfig: () => Promise<QuickShareConfigDTO>;
          updateQuickShareConfig: (p: Partial<QuickShareConfigDTO>) => Promise<void>;
          getSources: () => Promise<CaptureSourceDTO[]>;
        };
      }
    ).screenlink ?? null;
  } catch {
    return null;
  }
}

// ─── QuickShareDialog ────────────────────────────────────────────────────

interface QuickShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * QuickShareDialog — Quick one-shot share dialog using the existing pipeline.
 *
 * Allows selecting group → source kind → source → preset → audio mode
 * then starts a share via the shared startShare coordinator (same
 * coordinator used by the normal Share Setup). Passes the group
 * explicitly to the coordinator.
 *
 * Group precedence:
 *   1. Currently selected group when valid
 *   2. Last Quick Share group when still joined
 *   3. The only group when exactly one group exists
 *   4. Otherwise no automatic selection (user must choose)
 *
 * Multiple groups are never resolved to the first arbitrary group.
 *
 * Recent selections are persisted only after a successful start.
 * Failed Quick Share attempts leave the dialog open and do not
 * overwrite the saved last-successful selection.
 */
export function QuickShareDialog({ open, onOpenChange }: QuickShareDialogProps) {
  // ── Store state ─────────────────────────────────────────────────
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
  const groupOrder = useStore((s) => s.groupOrder);
  const setSelectedGroupId = useStore((s) => s.setSelectedGroupId);
  const isSharing = useStore((s) => s.isSharing);
  const navigate = useStore((s) => s.navigate);
  const lastScreenAudioMode = useStore((s) => s.lastScreenAudioMode);
  const lastWindowAudioMode = useStore((s) => s.lastWindowAudioMode);

  // ── Config loaded from persisted settings ──────────────────────
  const [savedConfig, setSavedConfig] = useState<QuickShareConfigDTO | null>(null);

  // ── Form state ─────────────────────────────────────────────────
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [sourceKind, setSourceKind] = useState<"screen" | "window">("screen");
  const [sources, setSources] = useState<CaptureSourceDTO[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [presets, setPresets] = useState<
    Array<{ id: string; name: string; settings: unknown }>
  >([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [audioMode, setAudioMode] = useState<AudioModeValue>(() => lastScreenAudioMode);
  const [starting, setStarting] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  // Audio options based on current source kind (icons added locally)
  const audioOptions = useMemo(() => {
    const none = { value: "none" as AudioModeValue, label: "No audio", icon: <VolumeX className="h-3.5 w-3.5" /> };
    if (sourceKind === "screen") {
      return [none, { value: "monitor" as AudioModeValue, label: "Filtered monitor audio", icon: <Headphones className="h-3.5 w-3.5" /> }];
    }
    return [none, { value: "application" as AudioModeValue, label: "Application audio", icon: <Volume2 className="h-3.5 w-3.5" /> }];
  }, [sourceKind]);

  // Validity check: selectedPresetId is truthy for both personal presets and Custom sentinel
  const canStart =
    selectedGroup &&
    selectedSourceId &&
    selectedPresetId &&
    !isSharing &&
    !starting;

  // ── Load config on open ─────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function init() {
      const api = getApi();

      // Load quick share config
      let config: QuickShareConfigDTO | null = null;
      if (api) {
        try {
          config = await api.getQuickShareConfig();
        } catch {
          config = null;
        }
        if (cancelled) return;
        setSavedConfig(config);

        if (config?.lastSourceKind) {
          setSourceKind(config.lastSourceKind);
        }
        if (config?.lastPresetId) {
          setSelectedPresetId(config.lastPresetId);
        }
      }

      // Apply group selection precedence:
      //   1. Currently selected group when valid
      //   2. Last Quick Share group when still joined
      //   3. The only group when exactly one group exists
      //   4. Otherwise leave empty (user must pick)
      const validIds = new Set(groupOrder);
      if (selectedGroupId && validIds.has(selectedGroupId)) {
        setSelectedGroup(selectedGroupId);
      } else if (
        config?.lastGroupId &&
        validIds.has(config.lastGroupId)
      ) {
        setSelectedGroup(config.lastGroupId);
      } else if (groupOrder.length === 1 && groupOrder[0]) {
        setSelectedGroup(groupOrder[0]);
      } else {
        setSelectedGroup("");
      }

      // Load sources
      setLoadingSources(true);
      setSourceError(null);
      if (api) {
        try {
          const srcs = await api.getSources();
          if (!cancelled) setSources(srcs);
        } catch (err) {
          if (!cancelled) {
            setSourceError(deriveSourceErrorText(err));
          }
        }
      }
      if (!cancelled) setLoadingSources(false);

      // Load presets
      try {
        const ps = await fetchQualityPresets();
        if (!cancelled) {
          setPresets(
            ps.map((p) => ({ id: p.id, name: p.name, settings: p.settings })),
          );
        }
      } catch {
        if (!cancelled) setPresets([]);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [open, groupOrder, selectedGroupId]);

  // ── Reset audio when source kind changes ───────────────────────
  useEffect(() => {
    setAudioMode((prev) =>
      resolveAudioMode(sourceKind, prev, lastScreenAudioMode, lastWindowAudioMode),
    );
  }, [sourceKind, lastScreenAudioMode, lastWindowAudioMode]);

  // ── Resolve quality override from selected preset id ────────────
  // The sentinel "__custom__" means Custom mode with VP9 defaults.
  // Personal preset IDs are looked up in the presets list.
  const resolveQualityOverride = useCallback(
    (presetId: string): SessionQualityOverride | null => {
      if (!presetId) return null;
      if (presetId === "__custom__") {
        return customPresetToOverride({
          width: CUSTOM_DEFAULT_WIDTH,
          height: CUSTOM_DEFAULT_HEIGHT,
          fps: CUSTOM_DEFAULT_FPS,
          bitrate: CUSTOM_DEFAULT_BITRATE_KBPS,
        });
      }
      const preset = presets.find((p) => p.id === presetId);
      if (!preset) return null;
      return presetSettingsToOverride(
        preset.settings as { video?: Record<string, unknown> } | undefined,
      );
    },
    [presets],
  );

  // ── Start share ────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!canStart) return;
    setStarting(true);

    const source = sources.find((s) => s.id === selectedSourceId);
    if (!source) {
      toast.error("Source not found");
      setStarting(false);
      return;
    }

    if (!groupsById[selectedGroup]) {
      toast.error("Selected group is no longer available");
      setStarting(false);
      return;
    }

    const qualityOverride = resolveQualityOverride(selectedPresetId);
    if (!qualityOverride) {
      toast.error("Could not resolve selected quality preset");
      setStarting(false);
      return;
    }

    try {
      const shareSource: ShareSource = {
        id: source.id,
        name: source.name,
        kind: source.kind,
        displayId: source.displayId ?? null,
        fingerprint: null,
        audioMode,
      };
      await startShare({
        groupId: selectedGroup,
        source: shareSource,
        qualityOverride,
      });

      // Success — persist recent Quick Share selection, select
      // the group, and navigate to the host view.
      const api = getApi();
      if (api) {
        await api
          .updateQuickShareConfig({
            lastGroupId: selectedGroup,
            lastSourceKind: sourceKind,
            lastPresetId: selectedPresetId,
          })
          .catch(() => {});
      }
      setSelectedGroupId(selectedGroup);
      toast.success("Quick share started");
      onOpenChange(false);
      navigate("host");
    } catch (err) {
      // Failure — leave dialog open, do not persist the
      // failed selection as the last successful Quick Share.
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Sharing failed: ${msg}`);
    } finally {
      setStarting(false);
    }
  }, [
    canStart,
    sources,
    selectedSourceId,
    selectedGroup,
    selectedPresetId,
    sourceKind,
    audioMode,
    setSelectedGroupId,
    onOpenChange,
    navigate,
    resolveQualityOverride,
    groupsById,
  ]);

  // ── Retry / refresh sources ────────────────────────────────────
  const refetchSources = useCallback(async () => {
    const api = getApi();
    if (!api) return;
    setLoadingSources(true);
    setSourceError(null);
    try {
      const srcs = await api.getSources();
      setSources(srcs);
    } catch (err) {
      setSourceError(deriveSourceErrorText(err));
    } finally {
      setLoadingSources(false);
    }
  }, []);

  // ── Derived: filtered source count ─────────────────────────────
  const filteredSources = useMemo(
    () => sources.filter((s) => s.kind === sourceKind),
    [sources, sourceKind],
  );

  // ── No groups state ────────────────────────────────────────────
  const hasGroups = groupOrder.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Quick Share</DialogTitle>
          <DialogDescription>
            Start sharing in a few clicks.
          </DialogDescription>
        </DialogHeader>

        {isSharing ? (
          <div className="py-6 text-center space-y-3">
            <p className="text-sm text-text-secondary">
              You are already sharing. Stop the current share before starting
              a new one.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                navigate("host");
              }}
            >
              Go to active share
            </Button>
          </div>
        ) : !hasGroups ? (
          <div className="py-6 text-center space-y-3">
            <div className="flex justify-center">
              <Users className="h-8 w-8 text-text-muted" />
            </div>
            <p className="text-sm text-text-secondary">
              No groups yet. Create or join a group first.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                useStore.getState().setOpenCreateGroupDialog(true);
              }}
            >
              Create group
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Group selection */}
            <div className="space-y-1.5">
              <Label htmlFor="quick-share-group">Group</Label>
              <Select value={selectedGroup} onValueChange={setSelectedGroup} disabled={starting}>
                <SelectTrigger id="quick-share-group">
                  <SelectValue placeholder="Select a group" />
                </SelectTrigger>
                <SelectContent>
                  {groupOrder.map((gid) => {
                    const g = groupsById[gid];
                    if (!g) return null;
                    return (
                      <SelectItem key={gid} value={gid}>
                        {g.name}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {/* Source kind */}
            <div className="space-y-1.5" role="group" aria-label="Source type">
              <Label>Source type</Label>
              <div className="flex gap-2">
                <Button
                  variant={sourceKind === "screen" ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  aria-pressed={sourceKind === "screen"}
                  onClick={() => setSourceKind("screen")}
                  disabled={starting}
                >
                  <Monitor className="h-3.5 w-3.5 mr-1" />
                  Screen
                </Button>
                <Button
                  variant={sourceKind === "window" ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  aria-pressed={sourceKind === "window"}
                  onClick={() => setSourceKind("window")}
                  disabled={starting}
                >
                  <Monitor className="h-3.5 w-3.5 mr-1" />
                  Window
                </Button>
              </div>
            </div>

            {/* Source picker */}
            <div className="space-y-1.5">
              <Label htmlFor="quick-share-source">Source</Label>
              {sourceError ? (
                <Alert variant="destructive" className="py-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle className="text-xs">Source error</AlertTitle>
                  <AlertDescription className="text-xs">
                    {sourceError}
                  </AlertDescription>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1"
                    onClick={refetchSources}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Retry
                  </Button>
                </Alert>
              ) : !loadingSources && filteredSources.length === 0 ? (
                <Alert variant="default" className="py-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle className="text-xs">No sources</AlertTitle>
                  <AlertDescription className="text-xs">
                    No {sourceKind === "screen" ? "screens" : "windows"} found.
                  </AlertDescription>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1"
                    onClick={refetchSources}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Refresh
                  </Button>
                </Alert>
              ) : (
                <Select
                  value={selectedSourceId}
                  onValueChange={setSelectedSourceId}
                  disabled={starting || loadingSources}
                >
                  <SelectTrigger id="quick-share-source">
                    <SelectValue
                      placeholder={loadingSources ? "Loading sources\u2026" : "Select a source"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredSources.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Preset — Custom always available + personal presets */}
            <div className="space-y-1.5">
              <Label htmlFor="quick-share-preset">Quality preset</Label>
              <Select value={selectedPresetId} onValueChange={setSelectedPresetId} disabled={starting}>
                <SelectTrigger id="quick-share-preset">
                  <SelectValue placeholder="Select a preset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__custom__">
                    Custom — {CUSTOM_DEFAULT_WIDTH}×{CUSTOM_DEFAULT_HEIGHT} @ {CUSTOM_DEFAULT_FPS} fps · {CUSTOM_DEFAULT_BITRATE_KBPS >= 1000 ? `${(CUSTOM_DEFAULT_BITRATE_KBPS / 1000).toFixed(1)} Mbps` : `${Math.round(CUSTOM_DEFAULT_BITRATE_KBPS)} kbps`}
                  </SelectItem>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Audio mode (source-aware) */}
            <div className="space-y-1.5" role="group" aria-label="Audio mode">
              <Label>Audio</Label>
              <div className="flex gap-2" role="radiogroup" aria-label="Audio options">
                {audioOptions.map((opt) => (
                  <Button
                    key={opt.value}
                    variant={audioMode === opt.value ? "default" : "outline"}
                    size="sm"
                    className="flex-1"
                    aria-pressed={audioMode === opt.value}
                    onClick={() => setAudioMode(opt.value)}
                    disabled={starting}
                  >
                    {opt.icon}
                    <span className="ml-1">{opt.label}</span>
                  </Button>
                ))}
              </div>
            </div>

            {/* Action */}
            <div className="pt-2">
              <Button
                variant="default"
                className="w-full"
                disabled={!canStart}
                onClick={handleStart}
              >
                {starting ? "Starting…" : "Start Quick Share"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
