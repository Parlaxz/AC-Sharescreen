import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { RefreshCw, AlertTriangle, Upload } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { PageHeader } from "@/components/layout/PageHeader";
import { PageSection } from "@/components/layout/PageSection";
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
import type { GroupQualitySettings, QualityPreset } from "@screenlink/shared";

// ─── Types ─────────────────────────────────────────────────────────────────

import {
  QualityEditorFields,
  RESOLUTION_OPTIONS,
  type QualityEditorFieldsValue,
  resolveResolution,
  qualityEditorFieldsValid,
} from "./QualityEditorFields.js";

/** Extended preset record with viewer-panel metadata */
type PresetRecord = QualityPreset;

// ─── Helpers ────────────────────────────────────────────────────────────────

function presetSummary(settings: GroupQualitySettings): {
  resolution: string;
  fps: number;
  bitrate: number;
  codec: string;
} {
  const video = settings.video;
  const w = video.sendWidth ?? 854;
  const h = video.sendHeight ?? 480;
  const f = video.sendFps ?? 15;
  const b = video.videoBitrateKbps ?? 650;
  const c = video.codec ?? "auto";
  return {
    resolution: `${w}×${h}`,
    fps: f,
    bitrate: b,
    codec: c.toUpperCase(),
  };
}

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
  const [formQuality, setFormQuality] = useState<QualityEditorFieldsValue>({
    resolutionValue: "1920x1080",
    customWidth: 1280,
    customHeight: 720,
    fps: 30,
    bitrate: 4000,
    codec: "vp9",
    contentHint: "motion",
    degradationPreference: "maintain-resolution",
  });
  const [formSaving, setFormSaving] = useState(false);
  const [showInViewer, setShowInViewer] = useState(false);
  const [viewerSlot, setViewerSlot] = useState<number | null>(null);

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
      setQualityPresets(items);
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
    setFormQuality({
      resolutionValue: "1920x1080",
      customWidth: 1280,
      customHeight: 720,
      fps: 30,
      bitrate: 4000,
      codec: "vp9",
      contentHint: "motion",
      degradationPreference: "maintain-resolution",
    });
    setShowInViewer(false);
    setViewerSlot(null);
    setFormSaving(false);
  }, []);

  const openNewEditor = useCallback(() => {
    resetForm();
    setEditingId(null);
    setEditorOpen(true);
  }, [resetForm]);

  const openEditEditor = useCallback(
    (preset: PresetRecord) => {
      const video = preset.settings.video;
      const w = video.sendWidth ?? 1280;
      const h = video.sendHeight ?? 720;
      // Match the saved w×h to a known resolution option, otherwise
      // fall back to Custom with the explicit dimensions preserved.
      const matched = RESOLUTION_OPTIONS.find(
        (o) => o.value !== "custom" && o.width === w && o.height === h,
      );
      setFormName(preset.name);
      setFormQuality({
        resolutionValue: matched?.value ?? "custom",
        customWidth: w,
        customHeight: h,
        fps: video.sendFps ?? 30,
        bitrate: video.videoBitrateKbps ?? 4000,
        codec: video.codec ?? "vp9",
        contentHint: video.contentHint ?? "motion",
        degradationPreference:
          video.degradationPreference ?? "maintain-resolution",
      });
      setEditingId(preset.id);
      setShowInViewer(preset.showInViewerPanel ?? false);
      setViewerSlot(preset.viewerPanelSlot ?? null);
      setEditorOpen(true);
    },
    [],
  );

  // ── Save (create or update) ─────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!formName.trim() || formSaving) return;
    const nameErr = isDuplicateName(formName, editingId);
    if (nameErr) {
      toast.error(nameErr);
      return;
    }
    if (qualityEditorFieldsValid(formQuality) !== null) return;
    setFormSaving(true);

    const { width: w, height: h } = resolveResolution(formQuality);
    const f = formQuality.fps;
    const b = formQuality.bitrate;

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
        codec: formQuality.codec,
        contentHint: formQuality.contentHint,
        preserveAspectRatio: true,
        preventUpscale: true,
        resolutionMode: "target-dimensions",
        scaleResolutionDownBy: 1,
        h264Profile: "auto",
        degradationPreference: formQuality.degradationPreference,
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
      // Validate viewer panel slot uniqueness
      if (showInViewer && viewerSlot != null) {
        const conflict = presets.find(
          (p): p is PresetRecord & { showInViewerPanel: true; viewerPanelSlot: number } =>
            p.id !== editingId && p.showInViewerPanel === true && p.viewerPanelSlot === viewerSlot,
        );
        if (conflict) {
          toast.error(`Slot ${viewerSlot} is already assigned to "${conflict.name}"`);
          setFormSaving(false);
          return;
        }
      }

      if (editingId) {
        await updateQualityPreset(editingId, {
          name: formName.trim(),
          settings,
          showInViewerPanel: showInViewer || undefined,
          viewerPanelSlot: showInViewer ? viewerSlot : null,
        });
        toast.success("Preset updated");
      } else {
        await createQualityPreset({
          name: formName.trim(),
          settings,
          showInViewerPanel: showInViewer || undefined,
          viewerPanelSlot: showInViewer ? viewerSlot : null,
        });
        toast.success("Preset created");
      }
      setEditorOpen(false);
      await loadPresets(); // refresh list — also syncs store via setQualityPresets
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
    formQuality,
    formSaving,
    showInViewer,
    viewerSlot,
    presets,
    loadPresets,
    setQualityPresets,
  ]);

  // ── Delete ──────────────────────────────────────────────────────
  const handleDelete = useCallback(
    async (id: string) => {
      setDeleting(true);
      try {
        await deleteQualityPreset(id);
        toast.success("Preset deleted");
        setDeleteId(null);
        await loadPresets(); // also syncs store via setQualityPresets
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
      await loadPresets(); // also syncs store
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
    async (settings: GroupQualitySettings) => {
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

  // ── Duplicate name check ───────────────────────────────────────
  const isDuplicateName = useCallback(
    (name: string, excludeId: string | null): string | null => {
      const trimmed = name.trim();
      if (!trimmed) return "Name is required";
      const existing = presets.find(
        (p) => p.id !== excludeId && p.name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (existing) return `A preset named "${existing.name}" already exists`;
      return null;
    },
    [presets],
  );

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-auto p-6 space-y-6" data-testid="presets-root">
      {/* ─── Page header ─────────────────────────────────────── */}
      <PageHeader
        title="Quality Presets"
        description="Create and manage stream quality presets"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
              <Upload className="h-3.5 w-3.5 mr-1" />
              Import
            </Button>
            <Button data-testid="preset-create-button" onClick={openNewEditor} disabled={loading}>New preset</Button>
          </div>
        }
      />

      {/* ─── Preset list section ─────────────────────────────── */}
      <PageSection title="Saved presets" description="Quality presets for streaming">
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
                  <Card className="h-full flex flex-col" data-testid="preset-row" data-preset-name={preset.name}>
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-sm">{preset.name}</CardTitle>
                        {preset.showInViewerPanel && preset.viewerPanelSlot != null && (
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
                            {preset.viewerPanelSlot}
                          </Badge>
                        )}
                      </div>
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
                            {sum.bitrate >= 1000 ? `${(sum.bitrate / 1000).toFixed(1)} Mbps` : `${Math.round(sum.bitrate)} kbps`}
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
                        data-testid="preset-duplicate-button"
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
                        data-testid="preset-delete-button"
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
        {!loading && !error && presets.length === 0 && (
          <div className="text-center py-12 text-text-muted">
            <p className="text-sm">No presets yet.</p>
            <p className="text-xs mt-1">
              Create a preset to save your preferred quality settings.
            </p>
          </div>
        )}
      </PageSection>

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

            <QualityEditorFields
              value={formQuality}
              onChange={setFormQuality}
              disabled={formSaving}
            />

            {/* Viewer Panel Pin */}
            <div className="space-y-3 pt-2 border-t border-border-subtle">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="show-in-viewer"
                  checked={showInViewer}
                  onCheckedChange={(checked) => {
                    setShowInViewer(checked === true);
                    if (checked !== true) setViewerSlot(null);
                  }}
                  disabled={formSaving}
                />
                <Label htmlFor="show-in-viewer" className="cursor-pointer">Show in viewer panel</Label>
              </div>
              {showInViewer && (
                <div className="space-y-1.5">
                  <Label htmlFor="viewer-slot">Keyboard shortcut</Label>
                  <Select
                    value={viewerSlot != null ? String(viewerSlot) : ""}
                    onValueChange={(value) => setViewerSlot(value ? parseInt(value, 10) : null)}
                    disabled={formSaving}
                  >
                    <SelectTrigger id="viewer-slot" className="w-full">
                      <SelectValue placeholder="Select slot…" />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-text-muted">
                    Press this number key on the viewer page to instantly apply this preset.
                  </p>
                </div>
              )}
            </div>
          </div>

          <SheetFooter className="mt-6">
            <SheetClose asChild>
              <Button variant="outline" disabled={formSaving}>
                Cancel
              </Button>
            </SheetClose>
            <Button
              data-testid="preset-save-button"
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
