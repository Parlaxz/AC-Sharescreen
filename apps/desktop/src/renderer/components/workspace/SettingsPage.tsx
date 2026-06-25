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
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
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
import type { PersistedSettings } from "../../../preload/api-types.js";

/**
 * Only the controls that are backed by a real persisted API are
 * rendered. The save path preserves all other fields in
 * hostQualityLimits and writes the user's own values to the correct
 * nested location. Success is reported only after persistence
 * completes.
 */
interface FormState {
  displayName: string;
  launchAtLogin: boolean;
  autoResumeLastMonitor: boolean;
  notificationsEnabled: boolean;
  allowViewerQualityRequests: boolean;
  quickShareEnabled: boolean;
  quickShareAccelerator: string;
}

export function SettingsPage() {
  // ── Load state ──────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Form state ──────────────────────────────────────────
  const [form, setForm] = useState<FormState>({
    displayName: "",
    launchAtLogin: false,
    autoResumeLastMonitor: false,
    notificationsEnabled: true,
    allowViewerQualityRequests: true,
    quickShareEnabled: true,
    quickShareAccelerator: "Super+Alt+S",
  });
  const [dirty, setDirty] = useState(false);
  const [displayNameDirty, setDisplayNameDirty] = useState(false);

  // ── Load settings on mount ──────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, quickShare] = await Promise.all([
        loadSettings(),
        loadQuickShareConfig(),
      ]);
      setForm({
        displayName:
          settings.hostDisplayName ?? settings.deviceIdentity?.displayName ?? "",
        launchAtLogin: settings.launchAtLogin ?? false,
        autoResumeLastMonitor: settings.autoResumeLastMonitor ?? false,
        notificationsEnabled: settings.notificationsEnabled ?? true,
        allowViewerQualityRequests:
          settings.hostQualityLimits?.allowViewerQualityRequests ?? true,
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

  // ── Field change helper ─────────────────────────────────
  const updateField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      if (key === "displayName") {
        setDisplayNameDirty(true);
      } else {
        setDirty(true);
      }
    },
    [],
  );

  // ── Save: build the correct payload and write ───────────
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // Display name persists via its own dedicated call.
      if (displayNameDirty && form.displayName.trim()) {
        await updateDisplayName(form.displayName.trim());
        setDisplayNameDirty(false);
      }

      // Build the general-settings partial. The viewer-requests
      // control is stored under hostQualityLimits, so we must merge
      // with the existing nested object instead of overwriting it.
      const partial: Record<string, unknown> = {};

      // Always send the top-level scalar fields when they exist in
      // the form (cheap, idempotent).
      partial.launchAtLogin = form.launchAtLogin;
      partial.autoResumeLastMonitor = form.autoResumeLastMonitor;
      partial.notificationsEnabled = form.notificationsEnabled;

      // hostQualityLimits.allowViewerQualityRequests: merge with
      // existing values to preserve the other limits.
      try {
        const current: PersistedSettings = await loadSettings();
        partial.hostQualityLimits = {
          ...(current.hostQualityLimits ?? {}),
          allowViewerQualityRequests: form.allowViewerQualityRequests,
        };
      } catch {
        // If we cannot read current settings, write the field with
        // safe defaults.
        partial.hostQualityLimits = {
          maxVideoBitrateKbps: 5000,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFps: 60,
          allowViewerQualityRequests: form.allowViewerQualityRequests,
        };
      }

      await saveSettings(partial);

      // Quick share config has its own preload method.
      await saveQuickShareConfig({
        shortcutEnabled: form.quickShareEnabled,
        shortcutAccelerator: form.quickShareAccelerator,
      });

      // Re-read to confirm persistence. Only show success if the
      // round-trip reads back the value we wrote.
      const [confirmed, confirmedQs] = await Promise.all([
        loadSettings(),
        loadQuickShareConfig(),
      ]);
      const ok =
        confirmed.launchAtLogin === form.launchAtLogin &&
        confirmed.autoResumeLastMonitor === form.autoResumeLastMonitor &&
        confirmed.notificationsEnabled === form.notificationsEnabled &&
        confirmed.hostQualityLimits?.allowViewerQualityRequests ===
          form.allowViewerQualityRequests &&
        confirmedQs.shortcutEnabled === form.quickShareEnabled &&
        confirmedQs.shortcutAccelerator === form.quickShareAccelerator;
      if (!ok) {
        throw new Error("Saved settings could not be verified");
      }

      setDirty(false);
      toast.success("Settings saved");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save settings";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [form, displayNameDirty]);

  // ── Switch row helper ───────────────────────────────────
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

  // ── Loading state ───────────────────────────────────────
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

  // ── Error state ─────────────────────────────────────────
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

  // ── Render form ─────────────────────────────────────────
  return (
    <div className="h-full overflow-auto p-5 space-y-5">
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

      {/* ─── Profile ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
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
        </CardContent>
      </Card>

      {/* ─── Startup ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Startup</CardTitle>
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
            id="auto-resume"
            label="Auto-resume last monitor share"
            tooltip="On startup, automatically resume sharing your last-used monitor without confirmation."
            checked={form.autoResumeLastMonitor}
            onCheckedChange={(v) => updateField("autoResumeLastMonitor", v)}
          />
        </CardContent>
      </Card>

      {/* ─── Notifications ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SwitchRow
            id="notifications-enabled"
            label="Enable general notifications"
            tooltip="Receive general system notifications from ScreenLink."
            checked={form.notificationsEnabled}
            onCheckedChange={(v) => updateField("notificationsEnabled", v)}
          />
        </CardContent>
      </Card>

      {/* ─── Host quality ──────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Host quality</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SwitchRow
            id="allow-viewer-requests"
            label="Allow viewer quality requests"
            tooltip="Allow viewers to request quality changes to your stream. Disable to always use your preset."
            checked={form.allowViewerQualityRequests}
            onCheckedChange={(v) => updateField("allowViewerQualityRequests", v)}
          />
        </CardContent>
      </Card>

      {/* ─── Quick Share ──────────────────────────────────── */}
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
    </div>
  );
}
