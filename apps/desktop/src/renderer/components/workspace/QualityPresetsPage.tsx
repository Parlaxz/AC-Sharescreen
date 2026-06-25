import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
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
import { Switch } from "@/components/ui/switch";
import {
  Separator,
} from "@/components/ui/separator";
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
import { useStore } from "@/stores/main-store";
import { cn } from "@/lib/utils";

/**
 * QualityPresetsPage — Quality preset management (Section 16.7).
 */
export function QualityPresetsPage() {
  // Pre-populated with example presets
  const [presets, setPresets] = useState<
    {
      id: string;
      name: string;
      resolution: string;
      fps: number;
      bitrate: number;
      codec: string;
      contentHint: string;
      systemAudio: boolean;
      isDefault: boolean;
      tags: string[];
    }[]
  >([
    {
      id: "1",
      name: "Balanced",
      resolution: "1920×1080",
      fps: 30,
      bitrate: 4000,
      codec: "H264",
      contentHint: "motion",
      systemAudio: true,
      isDefault: true,
      tags: ["recommended"],
    },
    {
      id: "2",
      name: "Data saver",
      resolution: "854×480",
      fps: 15,
      bitrate: 800,
      codec: "VP9",
      contentHint: "text",
      systemAudio: false,
      isDefault: false,
      tags: ["low-bandwidth"],
    },
    {
      id: "3",
      name: "Clear",
      resolution: "1920×1080",
      fps: 60,
      bitrate: 10000,
      codec: "H264",
      contentHint: "detail",
      systemAudio: true,
      isDefault: false,
      tags: ["high-quality"],
    },
  ]);

  // ── Sheet state ─────────────────────────────────────────────────
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // ── Form state ──────────────────────────────────────────────────
  const [formName, setFormName] = useState("");
  const [formResolution, setFormResolution] = useState("1920x1080");
  const [formFps, setFormFps] = useState(30);
  const [formBitrate, setFormBitrate] = useState(4000);
  const [formCodec, setFormCodec] = useState("h264");
  const [formSystemAudio, setFormSystemAudio] = useState(false);
  const [formContentHint, setFormContentHint] = useState("motion");

  // ── Delete dialog ───────────────────────────────────────────────
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setFormName("");
    setFormResolution("1920x1080");
    setFormFps(30);
    setFormBitrate(4000);
    setFormCodec("h264");
    setFormSystemAudio(false);
    setFormContentHint("motion");
  }, []);

  const openNewEditor = useCallback(() => {
    resetForm();
    setEditingId(null);
    setEditorOpen(true);
  }, [resetForm]);

  const openEditEditor = useCallback(
    (id: string) => {
      const preset = presets.find((p) => p.id === id);
      if (!preset) return;
      setFormName(preset.name);
      setFormResolution(preset.resolution.replace("×", "x"));
      setFormFps(preset.fps);
      setFormBitrate(preset.bitrate);
      setFormCodec(preset.codec.toLowerCase());
      setFormSystemAudio(preset.systemAudio);
      setFormContentHint(preset.contentHint);
      setEditingId(id);
      setEditorOpen(true);
    },
    [presets],
  );

  const handleSave = useCallback(() => {
    const resolution = formResolution.replace("x", "×");
    if (editingId) {
      setPresets((prev) =>
        prev.map((p) =>
          p.id === editingId
            ? {
                ...p,
                name: formName,
                resolution,
                fps: formFps,
                bitrate: formBitrate,
                codec: formCodec.toUpperCase(),
                systemAudio: formSystemAudio,
                contentHint: formContentHint,
              }
            : p,
        ),
      );
      toast("Preset updated");
    } else {
      const newPreset = {
        id: String(Date.now()),
        name: formName,
        resolution,
        fps: formFps,
        bitrate: formBitrate,
        codec: formCodec.toUpperCase(),
        contentHint: formContentHint,
        systemAudio: formSystemAudio,
        isDefault: false,
        tags: [],
      };
      setPresets((prev) => [...prev, newPreset]);
      toast("Preset created");
    }
    setEditorOpen(false);
  }, [editingId, formName, formResolution, formFps, formBitrate, formCodec, formSystemAudio, formContentHint]);

  const handleDelete = useCallback((id: string) => {
    setPresets((prev) => prev.filter((p) => p.id !== id));
    setDeleteId(null);
    toast("Preset deleted");
  }, []);

  const handleMakeDefault = useCallback((id: string) => {
    setPresets((prev) =>
      prev.map((p) => ({ ...p, isDefault: p.id === id })),
    );
    toast("Default preset changed");
  }, []);

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* ─── Page header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">
          Quality Presets
        </h1>
        <div className="flex items-center gap-2">
          <Button onClick={openNewEditor}>New preset</Button>
        </div>
      </div>

      {/* ─── Preset grid ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <AnimatePresence mode="popLayout">
          {presets.map((preset) => (
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
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-sm">{preset.name}</CardTitle>
                    <div className="flex items-center gap-1">
                      {preset.isDefault && (
                        <Badge variant="default" className="text-[10px]">
                          Default
                        </Badge>
                      )}
                      {preset.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-[10px]">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1">
                  <div className="space-y-1 text-xs text-text-secondary">
                    <div className="flex justify-between">
                      <span>Resolution</span>
                      <span className="font-mono text-text-primary">{preset.resolution}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>FPS</span>
                      <span className="font-mono text-text-primary">{preset.fps}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Bitrate</span>
                      <span className="font-mono text-text-primary">
                        {preset.bitrate.toLocaleString()} kbps
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Codec</span>
                      <span className="font-mono text-text-primary">{preset.codec}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>System audio</span>
                      <span className="font-mono text-text-primary">
                        {preset.systemAudio ? "Yes" : "No"}
                      </span>
                    </div>
                  </div>
                </CardContent>
                <Separator />
                <CardFooter className="flex gap-1 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => openEditEditor(preset.id)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1"
                    onClick={() => setDeleteId(preset.id)}
                  >
                    Delete
                  </Button>
                  {!preset.isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleMakeDefault(preset.id)}
                    >
                      Make default
                    </Button>
                  )}
                </CardFooter>
              </Card>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {presets.length === 0 && (
        <div className="text-center py-12 text-text-muted">
          <p className="text-sm">No presets yet.</p>
          <p className="text-xs mt-1">Create a preset to save your preferred quality settings.</p>
        </div>
      )}

      {/* ─── Editor sheet ────────────────────────────────────── */}
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
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-resolution">Resolution</Label>
              <Select value={formResolution} onValueChange={setFormResolution}>
                <SelectTrigger id="preset-resolution">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3840x2160">3840×2160 (4K)</SelectItem>
                  <SelectItem value="2560x1440">2560×1440 (1440p)</SelectItem>
                  <SelectItem value="1920x1080">1920×1080 (1080p)</SelectItem>
                  <SelectItem value="1280x720">1280×720 (720p)</SelectItem>
                  <SelectItem value="854x480">854×480 (480p)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-fps">FPS</Label>
              <Input
                id="preset-fps"
                type="number"
                value={formFps}
                onChange={(e) => setFormFps(parseInt(e.target.value, 10) || 30)}
                min={1}
                max={120}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-bitrate">Bitrate (kbps)</Label>
              <Input
                id="preset-bitrate"
                type="number"
                value={formBitrate}
                onChange={(e) => setFormBitrate(parseInt(e.target.value, 10) || 1000)}
                min={100}
                max={50000}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-codec">Codec</Label>
              <Select value={formCodec} onValueChange={setFormCodec}>
                <SelectTrigger id="preset-codec">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="h264">H264</SelectItem>
                  <SelectItem value="vp8">VP8</SelectItem>
                  <SelectItem value="vp9">VP9</SelectItem>
                  <SelectItem value="av1">AV1</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-content-hint">Content hint</Label>
              <Select value={formContentHint} onValueChange={setFormContentHint}>
                <SelectTrigger id="preset-content-hint">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="detail">Detail</SelectItem>
                  <SelectItem value="motion">Motion</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="preset-system-audio">System audio</Label>
              <Switch
                id="preset-system-audio"
                checked={formSystemAudio}
                onCheckedChange={setFormSystemAudio}
              />
            </div>
          </div>

          <SheetFooter className="mt-6">
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button onClick={handleSave} disabled={!formName.trim()}>
              Save
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ─── Delete confirmation dialog ───────────────────────── */}
      <Dialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) setDeleteId(null); }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete preset</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this preset? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => deleteId && handleDelete(deleteId)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
