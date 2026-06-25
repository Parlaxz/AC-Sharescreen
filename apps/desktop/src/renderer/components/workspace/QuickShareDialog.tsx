import { useState, useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Monitor, VolumeX, Headphones, Volume2, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
  fetchQualityPresets,
} from "@/services/group-actions";
import type { QuickShareConfigDTO, CaptureSourceDTO } from "../../../preload/api-types.js";

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

// ─── Audio mode helpers ──────────────────────────────────────────────────

type AudioModeValue = "none" | "monitor" | "application";

interface AudioOption {
  value: AudioModeValue;
  label: string;
  icon: React.ReactNode;
}

function audioOptionsForKind(kind: "screen" | "window"): AudioOption[] {
  const opts: AudioOption[] = [
    { value: "none", label: "No audio", icon: <VolumeX className="h-3.5 w-3.5" /> },
  ];
  if (kind === "screen") {
    opts.push({ value: "monitor", label: "Filtered monitor audio", icon: <Headphones className="h-3.5 w-3.5" /> });
  } else {
    opts.push({ value: "application", label: "Application audio", icon: <Volume2 className="h-3.5 w-3.5" /> });
  }
  return opts;
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
 * then starts a share via the normal startShare coordinator.
 *
 * Handles no-groups and already-sharing states safely.
 * Uses persisted recent selections when valid.
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
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [audioMode, setAudioMode] = useState<AudioModeValue>(() => lastScreenAudioMode);
  const [starting, setStarting] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);

  // Audio options based on current source kind
  const audioOptions = useMemo(() => audioOptionsForKind(sourceKind), [sourceKind]);

  // Validity check
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
      if (api) {
        const config = await api.getQuickShareConfig();
        if (cancelled) return;
        setSavedConfig(config);

        // Restore last selections if valid
        if (config.lastGroupId && groupsById[config.lastGroupId]) {
          setSelectedGroup(config.lastGroupId);
        } else if (selectedGroupId && groupsById[selectedGroupId]) {
          setSelectedGroup(selectedGroupId);
        } else if (groupOrder.length > 0) {
          setSelectedGroup(groupOrder[0]!);
        }

        if (config.lastSourceKind) {
          setSourceKind(config.lastSourceKind);
        }
        if (config.lastPresetId) {
          setSelectedPresetId(config.lastPresetId);
        }
      } else {
        // No API — pick first group if available
        if (selectedGroupId && groupsById[selectedGroupId]) {
          setSelectedGroup(selectedGroupId);
        } else if (groupOrder.length > 0) {
          setSelectedGroup(groupOrder[0]!);
        }
      }

      // Load sources
      setLoadingSources(true);
      if (api) {
        try {
          const srcs = await api.getSources();
          if (!cancelled) setSources(srcs);
        } catch {
          // Sources unavailable
        }
      }
      if (!cancelled) setLoadingSources(false);

      // Load presets
      try {
        const ps = await fetchQualityPresets();
        if (!cancelled) {
          setPresets(ps as Array<{ id: string; name: string }>);
        }
      } catch {
        // Presets unavailable
      }
    }

    void init();
    return () => { cancelled = true; };
  }, [open, groupsById, groupOrder, selectedGroupId]);

  // ── Reset audio when source kind changes ───────────────────────
  useEffect(() => {
    const validModes: AudioModeValue[] =
      sourceKind === "screen" ? ["none", "monitor"] : ["none", "application"];
    const remembered = sourceKind === "screen" ? lastScreenAudioMode : lastWindowAudioMode;
    setAudioMode((prev) =>
      validModes.includes(prev) ? prev : remembered,
    );
  }, [sourceKind, lastScreenAudioMode, lastWindowAudioMode]);

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

    // Set group
    setSelectedGroupId(selectedGroup);

    // Persist quick share config
    const api = getApi();
    if (api) {
      await api.updateQuickShareConfig({
        lastGroupId: selectedGroup,
        lastSourceKind: sourceKind,
        lastPresetId: selectedPresetId,
      }).catch(() => {});
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
      await startShare(shareSource);
      toast.success("Quick share started");
      onOpenChange(false);
      navigate("overview");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Quick share failed";
      toast.error(msg);
    } finally {
      setStarting(false);
    }
  }, [
    canStart, sources, selectedSourceId, selectedGroup, selectedPresetId,
    sourceKind, audioMode, setSelectedGroupId, onOpenChange, navigate,
  ]);

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
              <Label>Group</Label>
              <Select value={selectedGroup} onValueChange={setSelectedGroup} disabled={starting}>
                <SelectTrigger>
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
            <div className="space-y-1.5">
              <Label>Source type</Label>
              <div className="flex gap-2">
                <Button
                  variant={sourceKind === "screen" ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
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
              <Label>Source</Label>
              <Select
                value={selectedSourceId}
                onValueChange={setSelectedSourceId}
                disabled={starting || loadingSources}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={loadingSources ? "Loading sources…" : "Select a source"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {sources
                    .filter((s) => s.kind === sourceKind)
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {/* Preset */}
            <div className="space-y-1.5">
              <Label>Quality preset</Label>
              <Select value={selectedPresetId} onValueChange={setSelectedPresetId} disabled={starting}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a preset" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Audio mode (source-aware) */}
            <div className="space-y-1.5">
              <Label>Audio</Label>
              <div className="flex gap-2">
                {audioOptions.map((opt) => (
                  <Button
                    key={opt.value}
                    variant={audioMode === opt.value ? "default" : "outline"}
                    size="sm"
                    className="flex-1"
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
