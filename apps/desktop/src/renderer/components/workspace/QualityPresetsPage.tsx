import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { RefreshCw, AlertTriangle, Download, Upload } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  SheetClose,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useStore } from "@/stores/main-store";
import {
  fetchQualityPresets,
  createQualityPreset,
  updateQualityPreset,
  deleteQualityPreset,
  duplicateQualityPreset,
  exportQualityPreset,
  importQualityPreset,
} from "@/services/group-actions";
import { saveSettings } from "@/services/settings-actions";

// ─── Types ─────────────────────────────────────────────────────────────────

interface PresetRecord {
  id: string;
  name: string;
  settings: Record<string, unknown>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function presetSummary(settings: Record<string, unknown>): {
  resolution: string;
  fps: number;
  bitrate: number;
  codec: string;
} {
  const video = (settings.video as Record<string, unknown>) ?? {};
  const w = (video.sendWidth as number) ?? 854;
  const h = (video.sendHeight as number) ?? 480;
  const f = (video.sendFps as number) ?? 15;
  const b = (video.videoBitrateKbps as number) ?? 650;
  const c = (video.codec as string) ?? "auto";
  return {
    resolution: `${w}×${h}`,
    fps: f,
    bitrate: b,
    codec: c.toUpperCase(),
  };
}

const RESOLUTION_OPTIONS = [
  { value: "3840x2160", label: "3840×2160 (4K)" },
  { value: "2560x1440", label: "2560×1440 (1440p)" },
  { value: "1920x1080", label: "1920×1080 (1080p)" },
  { value: "1280x720", label: "1280×720 (720p)" },
  { value: "854x480", label: "854×480 (480p)" },
];

const CODEC_OPTIONS = [
  { value: "h264", label: "H264" },
  { value: "vp8", label: "VP8" },
  { value: "vp9", label: "VP9" },
  { value: "av1", label: "AV1" },
];

const CONTENT_HINT_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "text", label: "Text" },
  { value: "detail", label: "Detail" },
  { value: "motion", label: "Motion" },
];

// ─── QualityPresetsPage ─────────────────────────────────────────────────────

/**
 * QualityPresetsPage — Quality preset management (Section 16.7).
 *
 * All data flows through the real preload API (listQualityPresets,
 * createQualityPreset, updateQualityPreset, deleteQualityPreset,
 * duplicateQualityPreset, exportQualityPreset, importQualityPreset).
 *
 * States: loading → (presets grid | empty) or error (with retry).
 */
export function QualityPresetsPage() {
  const qualityPresets = useStore((s) => s.qualityPresets);
  const setQualityPresets = useStore((s) => s.setQualityPresets);

  // ── Data state ───────────────────────────────────────────────────
  const [presets, setPresets] = useState<PresetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Sheet state ─────────────────────────────────────────────────
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // ── Form state ──────────────────────────────────────────────────
  const [formName, setFormName] = useState("");
  const [formResolution, setFormResolution] = useState("1920x1080");
  const [formFps, setFormFps] = useState(30);
  const [formBitrate, setFormBitrate] = useState(4000);
  const [formCodec, setFormCodec] = useState("vp9");
  const [formContentHint, setFormContentHint] = useState("motion");
  const [formSaving, setFormSaving] = useState(false);

  // ── Delete dialog ───────────────────────────────────────────────
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Import dialog ───────────────────────────────────────────────
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importString, setImportString] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // ── Load presets ────────────────────────────────────────────────
  const loadPresets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = (await fetchQualityPresets()) as PresetRecord[];
      setPresets(items);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load presets",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  // ── Form helpers ────────────────────────────────────────────────
  const resetForm = useCallback(() => {
    setFormName("");
    setFormResolution("1920x1080");
    setFormFps(30);
    setFormBitrate(4000);
    setFormCodec("vp9");
    setFormContentHint("motion");
    setFormSaving(false);
  }, []);

  const openNewEditor = useCallback(() => {
    resetForm();
    setEditingId(null);
    setEditorOpen(true);
  }, [resetForm]);

  const openEditEditor = useCallback(
    (preset: PresetRecord) => {
      const s = presetSummary(preset.settings);
      setFormName(preset.name);
      setFormResolution(s.resolution.replace("×", "x"));
      setFormFps(s.fps);
      setFormBitrate(s.bitrate);
      // Infer codec + content hint from settings
      const video = (preset.settings.video as Record<string, unknown>) ?? {};
      setFormCodec((video.codec as string) ?? "vp9");
      setFormContentHint((video.contentHint as string) ?? "motion");
      setEditingId(preset.id);
      setEditorOpen(true);
    },
    [],
  );

  // ── Save (create or update) ─────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!formName.trim() || formSaving) return;
    setFormSaving(true);

    const [wStr, hStr] = formResolution.split("x");
    const w = parseInt(wStr ?? "1920", 10);
    const h = parseInt(hStr ?? "1080", 10);
    const f = formFps;
    const b = formBitrate;

    const settings = {
      schemaVersion: 1,
      video: {
        videoBitrateKbps: b,
        sendWidth: w,
        sendHeight: h,
        sendFps: f,
        captureWidth: w,
        captureHeight: h,
        captureFps: f,
        codec: formCodec,
        contentHint: formContentHint,
        preserveAspectRatio: true,
        preventUpscale: true,
        resolutionMode: "target-dimensions",
        scaleResolutionDownBy: 1,
        h264Profile: "auto",
        degradationPreference: "maintain-resolution",
        scalabilityMode: null,
        cursorMode: "always",
        rtpPriority: "medium",
      },
      audio: {
        bitrateKbps: 64,
        channels: "stereo",
        bitrateMode: "vbr",
        dtx: false,
        fec: true,
        packetDurationMs: 20,
        redundantAudio: false,
      },
    };

    try {
      if (editingId) {
        await updateQualityPreset(editingId, {
          name: formName.trim(),
          settings,
        });
        toast.success("Preset updated");
      } else {
        await createQualityPreset({
          name: formName.trim(),
          settings,
        });
        toast.success("Preset created");
      }
      setEditorOpen(false);
      await loadPresets(); // refresh list
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to save preset";
      toast.error(msg);
    } finally {
      setFormSaving(false);
    }
  }, [
    editingId,
    formName,
    formResolution,
    formFps,
    formBitrate,
    formCodec,
    formContentHint,
    formSaving,
    loadPresets,
  ]);

  // ── Delete ──────────────────────────────────────────────────────
  const handleDelete = useCallback(
    async (id: string) => {
      setDeleting(true);
      try {
        await deleteQualityPreset(id);
        toast.success("Preset deleted");
        setDeleteId(null);
        await loadPresets();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to delete preset";
        toast.error(msg);
      } finally {
        setDeleting(false);
      }
    },
    [loadPresets],
  );

  // ── Duplicate ───────────────────────────────────────────────────
  const handleDuplicate = useCallback(
    async (id: string) => {
      try {
        const preset = presets.find((p) => p.id === id);
        if (!preset) return;
        const result = await duplicateQualityPreset(
          id,
          `${preset.name} (copy)`,
        );
        if (result) {
          toast.success(`Duplicated as "${result.name}"`);
          await loadPresets();
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to duplicate";
        toast.error(msg);
      }
    },
    [presets, loadPresets],
  );

  // ── Export ──────────────────────────────────────────────────────
  const handleExport = useCallback(async (id: string) => {
    try {
      const data = await exportQualityPreset(id);
      if (data) {
        await navigator.clipboard.writeText(data);
        toast.success("Preset exported to clipboard");
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to export";
      toast.error(msg);
    }
  }, []);

  // ── Import ──────────────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!importString.trim() || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      await importQualityPreset(importString.trim());
      toast.success("Preset imported");
      setImportDialogOpen(false);
      setImportString("");
      await loadPresets();
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Failed to import",
      );
    } finally {
      setImporting(false);
    }
  }, [importString, importing, loadPresets]);

  // ── Set as default ──────────────────────────────────────────────
  const handleSetDefault = useCallback(
    async (settings: Record<string, unknown>) => {
      try {
        await saveSettings({ globalQualityDefaults: settings });
        toast.success("Default preset changed");
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to set default";
        toast.error(msg);
      }
    },
    [],
  );

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* ─── Page header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">
          Quality Presets
        </h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
            <Upload className="h-3.5 w-3.5 mr-1" />
            Import
          </Button>
          <Button onClick={openNewEditor} disabled={loading}>New preset</Button>
        </div>
      </div>

      {/* ─── Loading state ────────────────────────────────────── */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-standard" />
          ))}
        </div>
      )}

      {/* ─── Error state ──────────────────────────────────────── */}
      {!loading && error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load presets</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={loadPresets}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Retry
          </Button>
        </Alert>
      )}

      {/* ─── Preset grid ──────────────────────────────────────── */}
      {!loading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence mode="popLayout">
            {presets.map((preset) => {
              const sum = presetSummary(preset.settings);
              return (
                <motion.div
                  key={preset.id}
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                >
                  <Card className="h-full flex flex-col">
                    <CardHeader>
                      <CardTitle className="text-sm">{preset.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1">
                      <div className="space-y-1 text-xs text-text-secondary">
                        <div className="flex justify-between">
                          <span>Resolution</span>
                          <span className="font-mono text-text-primary">{sum.resolution}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>FPS</span>
                          <span className="font-mono text-text-primary">{sum.fps}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Bitrate</span>
                          <span className="font-mono text-text-primary">
                            {sum.bitrate.toLocaleString()} kbps
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>Codec</span>
                          <span className="font-mono text-text-primary">{sum.codec}</span>
                        </div>
                      </div>
                    </CardContent>
                    <Separator />
                    <CardFooter className="flex gap-1 pt-2 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 min-w-[60px]"
                        onClick={() => openEditEditor(preset)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 min-w-[60px]"
                        onClick={() => handleDuplicate(preset.id)}
                      >
                        Duplicate
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 min-w-[60px]"
                        onClick={() => handleExport(preset.id)}
                      >
                        Export
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 min-w-[60px]"
                        onClick={() => setDeleteId(preset.id)}
                      >
                        Delete
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full mt-1"
                        onClick={() => handleSetDefault(preset.settings)}
                      >
                        Set as default
                      </Button>
                    </CardFooter>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* ─── Empty state ──────────────────────────────────────── */}
      {!loading && !error && presets.length === 0 && (
        <div className="text-center py-12 text-text-muted">
          <p className="text-sm">No presets yet.</p>
          <p className="text-xs mt-1">
            Create a preset to save your preferred quality settings.
          </p>
        </div>
      )}

      {/* ─── Editor sheet ─────────────────────────────────────── */}
      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent side="right" className="w-80 sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>{editingId ? "Edit preset" : "New preset"}</SheetTitle>
            <SheetDescription>
              Configure quality settings for this preset.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="preset-name">Name</Label>
              <Input
                id="preset-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="My preset"
                disabled={formSaving}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-resolution">Resolution</Label>
              <Select
                value={formResolution}
                onValueChange={setFormResolution}
                disabled={formSaving}
              >
                <SelectTrigger id="preset-resolution">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOLUTION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-fps">FPS</Label>
              <Input
                id="preset-fps"
                type="number"
                value={formFps}
                onChange={(e) =>
                  setFormFps(parseInt(e.target.value, 10) || 30)
                }
                min={1}
                max={120}
                disabled={formSaving}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-bitrate">Bitrate (kbps)</Label>
              <Input
                id="preset-bitrate"
                type="number"
                value={formBitrate}
                onChange={(e) =>
                  setFormBitrate(parseInt(e.target.value, 10) || 1000)
                }
                min={100}
                max={50000}
                disabled={formSaving}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-codec">Codec</Label>
              <Select
                value={formCodec}
                onValueChange={setFormCodec}
                disabled={formSaving}
              >
                <SelectTrigger id="preset-codec">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CODEC_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-content-hint">Content hint</Label>
              <Select
                value={formContentHint}
                onValueChange={setFormContentHint}
                disabled={formSaving}
              >
                <SelectTrigger id="preset-content-hint">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTENT_HINT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

          </div>

          <SheetFooter className="mt-6">
            <SheetClose asChild>
              <Button variant="outline" disabled={formSaving}>
                Cancel
              </Button>
            </SheetClose>
            <Button
              onClick={handleSave}
              disabled={!formName.trim() || formSaving}
            >
              {formSaving ? "Saving…" : "Save"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ─── Delete confirmation dialog ───────────────────────── */}
      <Dialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete preset</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this preset? This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => deleteId && handleDelete(deleteId)}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Import dialog ────────────────────────────────────── */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Import preset</DialogTitle>
            <DialogDescription>
              Paste an exported preset string to import it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="import-preset-string">Preset data</Label>
              <Input
                id="import-preset-string"
                value={importString}
                onChange={(e) => setImportString(e.target.value)}
                placeholder="SLQP1:…"
                disabled={importing}
                autoFocus
              />
            </div>
            {importError && (
              <p className="text-sm text-danger" role="alert">
                {importError}
              </p>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={importing}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="default"
              disabled={!importString.trim() || importing}
              onClick={handleImport}
            >
              {importing ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
