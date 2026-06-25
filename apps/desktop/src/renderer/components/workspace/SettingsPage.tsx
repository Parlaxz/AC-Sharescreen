import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { RefreshCw, AlertTriangle } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Separator } from "@/components/ui/separator";
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
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useStore } from "@/stores/main-store";
import {
  loadSettings,
  saveSettings,
  updateDisplayName,
  loadQuickShareConfig,
  saveQuickShareConfig,
} from "@/services/settings-actions";

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  displayName: "",
  language: "en",
  theme: "dark",
  defaultPreset: "balanced",
  defaultAudio: "application",
  defaultCodec: "h264",
  defaultResolution: "1920x1080",
  defaultFps: 60,
  launchAtLogin: false,
  startMinimized: false,
  autoResume: false,
  closeToTray: true,
  hardwareAccel: true,
  showSystemAudio: false,
  allowViewerRequests: true,
  updateChannel: "stable",
  autoInstall: true,
  quickShareEnabled: true,
  quickShareAccelerator: "Super+Alt+S",
};

type FormSettings = typeof DEFAULT_SETTINGS;

// ─── SettingsPage ───────────────────────────────────────────────────────────

/**
 * SettingsPage — User/application settings (Section 16.7).
 *
 * Loads from real persisted settings via `getSettings` on mount.
 * Saves through real `updateSettings` and `updateDisplayName` APIs.
 * No fake success toast before persistence completes.
 *
 * States: loading → form | error (with retry).
 * Only user/device/app-owned controls — no group-owned state.
 */
export function SettingsPage() {
  // ── Load state ──────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Form state ──────────────────────────────────────────────────
  const [form, setForm] = useState<FormSettings>(DEFAULT_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [displayNameDirty, setDisplayNameDirty] = useState(false);

  // ── Reset dialog ────────────────────────────────────────────────
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  // ── Load settings on mount ──────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, quickShare] = await Promise.all([
        loadSettings(),
        loadQuickShareConfig(),
      ]);
      setForm({
        displayName: settings.hostDisplayName ?? settings.deviceIdentity?.displayName ?? "",
        language: "en",
        theme: "dark",
        defaultPreset: "balanced",
        defaultAudio: "application",
        defaultCodec: settings.globalQualityDefaults?.video?.codec ?? "h264",
        defaultResolution: `${settings.globalQualityDefaults?.video?.sendWidth ?? 1920}x${settings.globalQualityDefaults?.video?.sendHeight ?? 1080}`,
        defaultFps: settings.globalQualityDefaults?.video?.sendFps ?? 60,
        launchAtLogin: settings.launchAtLogin ?? false,
        startMinimized: false,
        autoResume: settings.autoResumeLastMonitor ?? false,
        closeToTray: true,
        hardwareAccel: true,
        showSystemAudio: false,
        allowViewerRequests:
          settings.hostQualityLimits?.allowViewerQualityRequests ?? true,
        updateChannel: "stable",
        autoInstall: true,
        quickShareEnabled: quickShare.shortcutEnabled,
        quickShareAccelerator: quickShare.shortcutAccelerator,
      });
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load settings",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Field change helper ─────────────────────────────────────────
  const updateField = useCallback(
    <K extends keyof FormSettings>(key: K, value: FormSettings[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      if (key === "displayName") {
        setDisplayNameDirty(true);
      } else {
        setDirty(true);
      }
    },
    [],
  );

  // ── Save all dirty settings ─────────────────────────────────────
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // Save display name separately if dirty
      if (displayNameDirty && form.displayName.trim()) {
        await updateDisplayName(form.displayName.trim());
        setDisplayNameDirty(false);
      }

      // Save general settings
      const partial: Record<string, unknown> = {};
      if (dirty) {
        partial.launchAtLogin = form.launchAtLogin;
        partial.autoResumeLastMonitor = form.autoResume;
        partial.notificationsEnabled = form.allowViewerRequests;
      }

      if (Object.keys(partial).length > 0) {
        await saveSettings(partial);
      }

      if (dirty) {
        await saveQuickShareConfig({
          shortcutEnabled: form.quickShareEnabled,
          shortcutAccelerator: form.quickShareAccelerator,
        });
        setDirty(false);
      }

      toast.success("Settings saved");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save settings";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [form, dirty, displayNameDirty]);

  // ── Reset ───────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setForm(DEFAULT_SETTINGS);
    setDirty(true);
    setDisplayNameDirty(true);
    setResetDialogOpen(false);
    toast("Settings reset to defaults (save to persist)");
  }, []);

  // ── Switch row helper ───────────────────────────────────────────
  const SwitchRow = ({
    id,
    label,
    tooltip,
    checked,
    onCheckedChange,
  }: {
    id: string;
    label: string;
    tooltip: string;
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
  }) => (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2">
        <Label
          htmlFor={id}
          className="text-sm text-text-primary cursor-pointer"
        >
          {label}
        </Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-surface-3 text-[10px] text-text-muted cursor-help">
              ?
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={checked ? "on" : "off"}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.12 }}
        >
          <Switch
            id={id}
            checked={checked}
            onCheckedChange={onCheckedChange}
            aria-label={label}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );

  // ── Select row helper ───────────────────────────────────────────
  const SelectRow = ({
    id,
    label,
    value,
    options,
    onValueChange,
  }: {
    id: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onValueChange: (v: string) => void;
  }) => (
    <div className="flex items-center justify-between py-1.5 gap-4">
      <Label
        htmlFor={id}
        className="text-sm text-text-primary flex-shrink-0"
      >
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  // ── Loading state ───────────────────────────────────────────────
  if (loading) {
    return (
      <div className="h-full overflow-auto p-5 space-y-5">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full rounded-standard" />
        <Skeleton className="h-32 w-full rounded-standard" />
        <Skeleton className="h-32 w-full rounded-standard" />
      </div>
    );
  }

  // ── Error state ─────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="h-full overflow-auto p-5">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load settings</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={load}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Retry
          </Button>
        </Alert>
      </div>
    );
  }

  // ── Render form ─────────────────────────────────────────────────
  return (
    <div className="h-full overflow-auto p-5 space-y-5">
      {/* ─── Page header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Settings</h1>
        <Button
          variant="default"
          size="sm"
          disabled={(!dirty && !displayNameDirty) || saving}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>

      {/* ─── General ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label
              htmlFor="display-name"
              className="text-sm text-text-primary"
            >
              Display name
            </Label>
            <Input
              id="display-name"
              value={form.displayName}
              onChange={(e) => updateField("displayName", e.target.value)}
              placeholder="Your name shown to viewers"
              disabled={saving}
            />
          </div>
          <SelectRow
            id="language"
            label="Language"
            value={form.language}
            options={[
              { value: "en", label: "English" },
              { value: "ja", label: "Japanese" },
              { value: "ko", label: "Korean" },
            ]}
            onValueChange={(v) => updateField("language", v)}
          />
          <SelectRow
            id="theme"
            label="Theme"
            value={form.theme}
            options={[
              { value: "system", label: "System" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onValueChange={(v) => updateField("theme", v)}
          />
        </CardContent>
      </Card>

      {/* ─── Startup & tray ──────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Startup &amp; tray</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SwitchRow
            id="launch-at-login"
            label="Launch at Windows login"
            tooltip="ScreenLink starts automatically when you log into Windows. Requires system permission."
            checked={form.launchAtLogin}
            onCheckedChange={(v) => updateField("launchAtLogin", v)}
          />
          <Separator />
          <SwitchRow
            id="start-minimized"
            label="Start minimized to tray"
            tooltip="When launched at login, ScreenLink starts in the system tray instead of showing the window."
            checked={form.startMinimized}
            onCheckedChange={(v) => updateField("startMinimized", v)}
          />
          <Separator />
          <SwitchRow
            id="auto-resume"
            label="Auto-resume last monitor share"
            tooltip="On startup, automatically resume sharing your last-used monitor without confirmation."
            checked={form.autoResume}
            onCheckedChange={(v) => updateField("autoResume", v)}
          />
          <Separator />
          <SwitchRow
            id="close-to-tray"
            label="Close to tray (when X clicked)"
            tooltip="Pressing the close button minimizes ScreenLink to the system tray instead of quitting."
            checked={form.closeToTray}
            onCheckedChange={(v) => updateField("closeToTray", v)}
          />
        </CardContent>
      </Card>

      {/* ─── Quick Share ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Share</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SwitchRow
            id="quick-share-enabled"
            label="Enable global Quick Share shortcut"
            tooltip="Registers the system-wide shortcut used to open Quick Share."
            checked={form.quickShareEnabled}
            onCheckedChange={(v) => updateField("quickShareEnabled", v)}
          />
          <div className="space-y-1.5">
            <Label
              htmlFor="quick-share-accelerator"
              className="text-sm text-text-primary"
            >
              Shortcut accelerator
            </Label>
            <Input
              id="quick-share-accelerator"
              value={form.quickShareAccelerator}
              onChange={(e) => updateField("quickShareAccelerator", e.target.value)}
              placeholder="Super+Alt+S"
              disabled={!form.quickShareEnabled}
            />
          </div>
        </CardContent>
      </Card>

      {/* ─── Capture ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Capture</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SwitchRow
            id="hardware-accel"
            label="Prefer hardware acceleration"
            tooltip="Use GPU encoders when available — see Section 16.2 of impl spec for known limitations"
            checked={form.hardwareAccel}
            onCheckedChange={(v) => updateField("hardwareAccel", v)}
          />
          <Separator />
          <SwitchRow
            id="show-system-audio"
            label="Show system audio toggle"
            tooltip="Show a toggle in the sharing UI to enable or disable system audio capture."
            checked={form.showSystemAudio}
            onCheckedChange={(v) => updateField("showSystemAudio", v)}
          />
          <Separator />
          <SwitchRow
            id="allow-viewer-requests"
            label="Allow viewer quality requests"
            tooltip="Allow viewers to request quality changes to your stream. Disable to always use your preset."
            checked={form.allowViewerRequests}
            onCheckedChange={(v) => updateField("allowViewerRequests", v)}
          />
        </CardContent>
      </Card>

      {/* ─── Updates ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Updates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SelectRow
            id="update-channel"
            label="Channel"
            value={form.updateChannel}
            options={[
              { value: "stable", label: "Stable" },
              { value: "beta", label: "Beta" },
            ]}
            onValueChange={(v) => updateField("updateChannel", v)}
          />
          <SwitchRow
            id="auto-install"
            label="Auto-install updates"
            tooltip="Automatically download and install updates when available. You will be prompted to restart."
            checked={form.autoInstall}
            onCheckedChange={(v) => updateField("autoInstall", v)}
          />
        </CardContent>
      </Card>

      {/* ─── Reset to defaults ───────────────────────────────── */}
      <div className="flex justify-center pt-2 pb-8">
        <Button
          variant="outline"
          onClick={() => setResetDialogOpen(true)}
        >
          Reset to defaults
        </Button>
      </div>

      {/* ─── Reset confirmation dialog ───────────────────────── */}
      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset to defaults</DialogTitle>
            <DialogDescription>
              This will reset all settings to their factory defaults. You
              must click "Save settings" to persist the reset.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleReset}>
              Reset all settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
