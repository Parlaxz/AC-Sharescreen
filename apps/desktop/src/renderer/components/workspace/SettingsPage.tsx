import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { RefreshCw, AlertTriangle, Save, History } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRecorder } from "@/components/ui/key-recorder";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageSection } from "@/components/layout/PageSection";
import {
  loadSettings,
  saveSettings,
  updateDisplayName,
  loadQuickShareConfig,
  saveQuickShareConfig,
} from "@/services/settings-actions";
import { useIdentityStore } from "@/stores/identity-store";
import { getRuntime } from "@/services/phase3-runtime";
import { UpdatesSettingsSection } from "@/components/settings/UpdatesSettingsSection";
import { StreamHistorySection } from "@/components/settings/StreamHistorySection";
import type { PersistedSettings, ShortcutBinding, StreamInfoCardConfig } from "@screenlink/shared";
import {
  defaultHostQualityLimits,
  defaultGlobalQualityDefaults,
  defaultStreamInfoCard,
  defaultQuickShareAccelerator,
  defaultViewerBitrateSliderMaxKbps,
  defaultViewerMaxVolumePercent,
  defaultHourlyEstimateDurationMs,
  defaultDiscordMuteShortcut,
  defaultDiscordDeafenShortcut,
  defaultShowCompareControls,
} from "@screenlink/shared";
import type { QuickShareConfigDTO } from "../../../preload/api-types.js";

interface SettingsForm {
  displayName: string;
  launchAtLogin: boolean;
  autoResumeLastMonitor: boolean;
  notificationsEnabled: boolean;
  maxVideoBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  allowViewerQualityRequests: boolean;
  viewerBitrateSliderMaxKbps: number;
  defaultCodec: "auto" | "vp9" | "av1" | "h264" | "vp8";
  quickShareEnabled: boolean;
  quickShareAccelerator: string;
  discordMuteShortcut: string;
  discordDeafenShortcut: string;
  discordDeafenScreenLink: boolean;
  viewerMaxVolumePercent: number;
  hourlyEstimateDurationMs: number;
  streamInfoCardVisible: boolean;
  streamInfoCardShowResolution: boolean;
  streamInfoCardShowFps: boolean;
  streamInfoCardShowBitrate: boolean;
  streamInfoCardShowDroppedFrames: boolean;
  streamInfoCardShowNetworkUsage: boolean;
  streamInfoCardPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  streamInfoCardFontSize: number;
  streamInfoCardTextColor: string;
  streamInfoCardBoxOpacity: number;
  streamInfoCardBoxWidth: number;
  showCompareControls: boolean;
}

const _hq = defaultHostQualityLimits();
const _gq = defaultGlobalQualityDefaults();
const _sic = defaultStreamInfoCard();

const DEFAULT_FORM: SettingsForm = {
  displayName: "User",
  launchAtLogin: false,
  autoResumeLastMonitor: false,
  notificationsEnabled: true,
  maxVideoBitrateKbps: _hq.maxVideoBitrateKbps,
  maxWidth: _hq.maxWidth,
  maxHeight: _hq.maxHeight,
  maxFps: _hq.maxFps,
  allowViewerQualityRequests: _hq.allowViewerQualityRequests,
  viewerBitrateSliderMaxKbps: defaultViewerBitrateSliderMaxKbps(),
  defaultCodec: _gq.video.codec,
  quickShareEnabled: true,
  quickShareAccelerator: defaultQuickShareAccelerator(),
  discordMuteShortcut: `${defaultDiscordMuteShortcut().modifiers[0] === "alt" ? "Alt" : ""}+${defaultDiscordMuteShortcut().key}`,
  discordDeafenShortcut: `${defaultDiscordDeafenShortcut().modifiers[0] === "alt" ? "Alt" : ""}+${defaultDiscordDeafenShortcut().key}`,
  discordDeafenScreenLink: true,
  viewerMaxVolumePercent: defaultViewerMaxVolumePercent(),
  hourlyEstimateDurationMs: defaultHourlyEstimateDurationMs(),
  streamInfoCardVisible: _sic.visible,
  streamInfoCardShowResolution: _sic.showResolution,
  streamInfoCardShowFps: _sic.showFps,
  streamInfoCardShowBitrate: _sic.showBitrate,
  streamInfoCardShowDroppedFrames: _sic.showDroppedFrames,
  streamInfoCardShowNetworkUsage: _sic.showNetworkUsage,
  streamInfoCardPosition: _sic.position,
  streamInfoCardFontSize: _sic.fontSize,
  streamInfoCardTextColor: _sic.textColor,
  streamInfoCardBoxOpacity: _sic.boxOpacity,
  streamInfoCardBoxWidth: _sic.boxWidth,
  showCompareControls: defaultShowCompareControls(),
};

const DEFAULT_AUDIO_SETTINGS = {
  bitrateKbps: 64,
  channels: "stereo" as const,
  bitrateMode: "vbr" as const,
  dtx: false,
  fec: true,
  packetDurationMs: 20 as const,
  redundantAudio: false,
};

const CODEC_OPTIONS: Array<{ value: SettingsForm["defaultCodec"]; label: string }> = [
  { value: "vp9", label: "VP9" },
  { value: "av1", label: "AV1" },
  { value: "h264", label: "H.264" },
  { value: "vp8", label: "VP8" },
];

function formatShortcutBinding(binding: ShortcutBinding | undefined): string {
  if (!binding) return "";
  const prefix = binding.modifiers.map((m) => m[0].toUpperCase() + m.slice(1)).join("+");
  return prefix ? `${prefix}+${binding.key}` : binding.key;
}

function parseShortcutString(str: string): ShortcutBinding {
  const parts = str.trim().split("+");
  if (parts.length === 0) return { modifiers: [], key: "" };
  const key = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1).map((m) => m.trim().toLowerCase() as ShortcutBinding["modifiers"][number]);
  return { modifiers: modifiers.filter((m) => ["alt", "ctrl", "shift", "win"].includes(m)), key };
}

function buildForm(
  settings: PersistedSettings,
  quickShare: QuickShareConfigDTO,
): SettingsForm {
  return {
    displayName: settings.deviceIdentity.displayName ?? settings.hostDisplayName ?? DEFAULT_FORM.displayName,
    launchAtLogin: settings.launchAtLogin ?? DEFAULT_FORM.launchAtLogin,
    autoResumeLastMonitor: settings.autoResumeLastMonitor ?? DEFAULT_FORM.autoResumeLastMonitor,
    notificationsEnabled: settings.notificationsEnabled ?? DEFAULT_FORM.notificationsEnabled,
    maxVideoBitrateKbps:
      settings.hostQualityLimits?.maxVideoBitrateKbps ?? DEFAULT_FORM.maxVideoBitrateKbps,
    maxWidth: settings.hostQualityLimits?.maxWidth ?? DEFAULT_FORM.maxWidth,
    maxHeight: settings.hostQualityLimits?.maxHeight ?? DEFAULT_FORM.maxHeight,
    maxFps: settings.hostQualityLimits?.maxFps ?? DEFAULT_FORM.maxFps,
    allowViewerQualityRequests:
      settings.hostQualityLimits?.allowViewerQualityRequests ?? DEFAULT_FORM.allowViewerQualityRequests,
    viewerBitrateSliderMaxKbps:
      settings.viewerBitrateSliderMaxKbps ?? DEFAULT_FORM.viewerBitrateSliderMaxKbps,
    defaultCodec:
      (settings.globalQualityDefaults?.video?.codec === "av1" ||
      settings.globalQualityDefaults?.video?.codec === "h264" ||
      settings.globalQualityDefaults?.video?.codec === "vp8" ||
      settings.globalQualityDefaults?.video?.codec === "vp9"
        ? settings.globalQualityDefaults.video.codec
        : DEFAULT_FORM.defaultCodec),
    quickShareEnabled: quickShare.shortcutEnabled,
    quickShareAccelerator: quickShare.shortcutAccelerator,
    discordMuteShortcut: formatShortcutBinding(settings.discordMuteShortcut) || DEFAULT_FORM.discordMuteShortcut,
    discordDeafenShortcut: formatShortcutBinding(settings.discordDeafenShortcut) || DEFAULT_FORM.discordDeafenShortcut,
    discordDeafenScreenLink: settings.discordDeafenScreenLink ?? DEFAULT_FORM.discordDeafenScreenLink,
    viewerMaxVolumePercent: settings.viewerMaxVolumePercent ?? DEFAULT_FORM.viewerMaxVolumePercent,
    hourlyEstimateDurationMs: settings.hourlyEstimateDurationMs ?? DEFAULT_FORM.hourlyEstimateDurationMs,
    streamInfoCardVisible: settings.streamInfoCard?.visible ?? DEFAULT_FORM.streamInfoCardVisible,
    streamInfoCardShowResolution: settings.streamInfoCard?.showResolution ?? DEFAULT_FORM.streamInfoCardShowResolution,
    streamInfoCardShowFps: settings.streamInfoCard?.showFps ?? DEFAULT_FORM.streamInfoCardShowFps,
    streamInfoCardShowBitrate: settings.streamInfoCard?.showBitrate ?? DEFAULT_FORM.streamInfoCardShowBitrate,
    streamInfoCardShowDroppedFrames: settings.streamInfoCard?.showDroppedFrames ?? DEFAULT_FORM.streamInfoCardShowDroppedFrames,
    streamInfoCardShowNetworkUsage: settings.streamInfoCard?.showNetworkUsage ?? DEFAULT_FORM.streamInfoCardShowNetworkUsage,
    streamInfoCardPosition: settings.streamInfoCard?.position ?? DEFAULT_FORM.streamInfoCardPosition,
    streamInfoCardFontSize: settings.streamInfoCard?.fontSize ?? DEFAULT_FORM.streamInfoCardFontSize,
    streamInfoCardTextColor: settings.streamInfoCard?.textColor ?? DEFAULT_FORM.streamInfoCardTextColor,
    streamInfoCardBoxOpacity: settings.streamInfoCard?.boxOpacity ?? DEFAULT_FORM.streamInfoCardBoxOpacity,
    streamInfoCardBoxWidth: settings.streamInfoCard?.boxWidth ?? DEFAULT_FORM.streamInfoCardBoxWidth,
    showCompareControls: settings.showCompareControls ?? DEFAULT_FORM.showCompareControls,
  };
}

function formsEqual(a: SettingsForm, b: SettingsForm): boolean {
  return (
    a.displayName === b.displayName &&
    a.launchAtLogin === b.launchAtLogin &&
    a.autoResumeLastMonitor === b.autoResumeLastMonitor &&
    a.notificationsEnabled === b.notificationsEnabled &&
    a.maxVideoBitrateKbps === b.maxVideoBitrateKbps &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight &&
    a.maxFps === b.maxFps &&
    a.allowViewerQualityRequests === b.allowViewerQualityRequests &&
    a.viewerBitrateSliderMaxKbps === b.viewerBitrateSliderMaxKbps &&
    a.defaultCodec === b.defaultCodec &&
    a.quickShareEnabled === b.quickShareEnabled &&
    a.quickShareAccelerator === b.quickShareAccelerator &&
    a.discordMuteShortcut === b.discordMuteShortcut &&
    a.discordDeafenShortcut === b.discordDeafenShortcut &&
    a.discordDeafenScreenLink === b.discordDeafenScreenLink &&
    a.viewerMaxVolumePercent === b.viewerMaxVolumePercent &&
    a.hourlyEstimateDurationMs === b.hourlyEstimateDurationMs &&
    a.streamInfoCardVisible === b.streamInfoCardVisible &&
    a.streamInfoCardShowResolution === b.streamInfoCardShowResolution &&
    a.streamInfoCardShowFps === b.streamInfoCardShowFps &&
    a.streamInfoCardShowBitrate === b.streamInfoCardShowBitrate &&
    a.streamInfoCardShowDroppedFrames === b.streamInfoCardShowDroppedFrames &&
    a.streamInfoCardShowNetworkUsage === b.streamInfoCardShowNetworkUsage &&
    a.streamInfoCardFontSize === b.streamInfoCardFontSize &&
    a.streamInfoCardTextColor === b.streamInfoCardTextColor &&
    a.streamInfoCardBoxOpacity === b.streamInfoCardBoxOpacity &&
    a.streamInfoCardBoxWidth === b.streamInfoCardBoxWidth &&
    a.showCompareControls === b.showCompareControls
  );
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function SwitchRow({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <Label htmlFor={id} className="text-sm text-text-primary cursor-pointer">
        {label}
      </Label>
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
}

export function SettingsPage() {
  const [form, setForm] = useState<SettingsForm>(DEFAULT_FORM);
  const [cleanBaseline, setCleanBaseline] = useState<SettingsForm>(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const setLocalIdentity = useIdentityStore((s) => s.setLocalIdentity);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, quickShare] = await Promise.all([
        loadSettings(),
        loadQuickShareConfig(),
      ]);
      const nextForm = buildForm(settings, quickShare);
      setForm(nextForm);
      setCleanBaseline(nextForm);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateField = useCallback(<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const isDirty = useMemo(() => !formsEqual(form, cleanBaseline), [form, cleanBaseline]);

  const validateForm = useCallback((): string | null => {
    const trimmedName = form.displayName.trim();
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      return "Display Name must be 1–100 characters";
    }
    if (!isNonNegativeInteger(form.maxVideoBitrateKbps)) {
      return "Maximum bitrate must be a nonnegative integer";
    }
    if (!isNonNegativeInteger(form.maxWidth)) {
      return "Maximum width must be a nonnegative integer";
    }
    if (!isNonNegativeInteger(form.maxHeight)) {
      return "Maximum height must be a nonnegative integer";
    }
    if (!isNonNegativeInteger(form.maxFps)) {
      return "Maximum FPS must be a nonnegative integer";
    }
    if (!isNonNegativeInteger(form.viewerBitrateSliderMaxKbps)) {
      return "Viewer bitrate slider max must be a nonnegative integer";
    }
    if (!isNonNegativeInteger(form.viewerMaxVolumePercent) || form.viewerMaxVolumePercent < 1 || form.viewerMaxVolumePercent > 500) {
      return "Max volume must be an integer between 1 and 500";
    }
    if (!form.quickShareAccelerator.trim()) {
      return "Quick Share accelerator is required";
    }
    if (!parseShortcutString(form.discordMuteShortcut).key.trim()) {
      return "Discord mute shortcut is required";
    }
    if (!parseShortcutString(form.discordDeafenShortcut).key.trim()) {
      return "Discord deafen shortcut is required";
    }
    return null;
  }, [form]);

  const handleSave = useCallback(async () => {
    if (saving) {
      return;
    }

    const validationError = validateForm();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSaving(true);

    try {
      const trimmedDisplayName = form.displayName.trim();
      const returnedIdentity = await updateDisplayName(trimmedDisplayName);
      setLocalIdentity({
        deviceId: returnedIdentity.deviceId,
        displayName: returnedIdentity.displayName,
      });

      const settingsAfterNameSave = await loadSettings();
      if (settingsAfterNameSave.deviceIdentity.displayName !== trimmedDisplayName) {
        throw new Error("Display Name verification failed");
      }

      const mergedSettingsPartial: Partial<PersistedSettings> = {
        launchAtLogin: form.launchAtLogin,
        autoResumeLastMonitor: form.autoResumeLastMonitor,
        notificationsEnabled: form.notificationsEnabled,
        viewerBitrateSliderMaxKbps: form.viewerBitrateSliderMaxKbps,
        hostQualityLimits: {
          ...(settingsAfterNameSave.hostQualityLimits ?? {
            maxVideoBitrateKbps: DEFAULT_FORM.maxVideoBitrateKbps,
            maxWidth: DEFAULT_FORM.maxWidth,
            maxHeight: DEFAULT_FORM.maxHeight,
            maxFps: DEFAULT_FORM.maxFps,
            allowViewerQualityRequests: DEFAULT_FORM.allowViewerQualityRequests,
          }),
          maxVideoBitrateKbps: form.maxVideoBitrateKbps,
          maxWidth: form.maxWidth,
          maxHeight: form.maxHeight,
          maxFps: form.maxFps,
          allowViewerQualityRequests: form.allowViewerQualityRequests,
        },
        globalQualityDefaults: {
          schemaVersion: 1,
          video: {
            ...(settingsAfterNameSave.globalQualityDefaults?.video ?? {}),
            codec: form.defaultCodec,
          },
          audio: settingsAfterNameSave.globalQualityDefaults?.audio ?? DEFAULT_AUDIO_SETTINGS,
        },
        discordMuteShortcut: parseShortcutString(form.discordMuteShortcut),
        discordDeafenShortcut: parseShortcutString(form.discordDeafenShortcut),
        discordDeafenScreenLink: form.discordDeafenScreenLink,
        viewerMaxVolumePercent: form.viewerMaxVolumePercent,
        hourlyEstimateDurationMs: form.hourlyEstimateDurationMs,
        showCompareControls: form.showCompareControls,
        streamInfoCard: {
          visible: form.streamInfoCardVisible,
          showResolution: form.streamInfoCardShowResolution,
          showFps: form.streamInfoCardShowFps,
          showBitrate: form.streamInfoCardShowBitrate,
          showDroppedFrames: form.streamInfoCardShowDroppedFrames,
          showNetworkUsage: form.streamInfoCardShowNetworkUsage,
          position: form.streamInfoCardPosition,
          fontSize: form.streamInfoCardFontSize,
          textColor: form.streamInfoCardTextColor,
          boxOpacity: form.streamInfoCardBoxOpacity,
          boxWidth: form.streamInfoCardBoxWidth,
        },
      };

      await saveSettings(mergedSettingsPartial);

      // Normalise "Win" → "Super" before persisting so the accelerator
      // always matches what Electron's globalShortcut expects.
      const normalizedAccelerator = form.quickShareAccelerator.trim().replace(/\bWin\b/g, "Super");
      await saveQuickShareConfig({
        shortcutEnabled: form.quickShareEnabled,
        shortcutAccelerator: normalizedAccelerator,
      });

      const [verifiedSettings, verifiedQuickShare] = await Promise.all([
        loadSettings(),
        loadQuickShareConfig(),
      ]);

      const verifiedForm = buildForm(verifiedSettings, verifiedQuickShare);
      if (!formsEqual(verifiedForm, {
        ...form,
        displayName: trimmedDisplayName,
        quickShareAccelerator: normalizedAccelerator,
      })) {
        throw new Error("Saved settings could not be verified");
      }

      setLocalIdentity({
        deviceId: verifiedSettings.deviceIdentity.deviceId,
        displayName: verifiedSettings.deviceIdentity.displayName,
      });
      getRuntime()?.updateLocalDisplayName(verifiedSettings.deviceIdentity.displayName);

      setForm(verifiedForm);
      setCleanBaseline(verifiedForm);
      setSaveStatus("saved");
      toast.success("Settings saved");
    } catch (err) {
      setSaveStatus("error");
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }, [form, saving, setLocalIdentity, validateForm]);

  if (loading) {
    return (
      <div className="h-full overflow-auto p-5 space-y-5" role="status" aria-busy="true">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full rounded-standard" />
        <Skeleton className="h-32 w-full rounded-standard" />
        <Skeleton className="h-32 w-full rounded-standard" />
    </div>
  );
  }

  if (loadError) {
    return (
      <div className="h-full overflow-auto p-5">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load settings</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
          <Button variant="outline" size="sm" className="mt-2" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Retry
          </Button>
        </Alert>
    </div>
  );
}

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto p-5 space-y-5">
        <PageHeader
          title="Settings"
          description="Configure your ScreenLink preferences"
        />

      <PageSection title="Profile" description="Your display name shared with viewers">
        <Card>
          <CardContent className="pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="display-name">Display Name</Label>
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
      </PageSection>

      <PageSection title="Startup" description="Behavior when ScreenLink launches">
        <Card>
          <CardContent className="pt-4 space-y-1">
            <SwitchRow
              id="launch-at-login"
              label="Launch at login"
              checked={form.launchAtLogin}
              onCheckedChange={(value) => updateField("launchAtLogin", value)}
            />
            <Separator />
            <SwitchRow
              id="auto-resume-last-monitor"
              label="Auto-resume last monitor/source"
              checked={form.autoResumeLastMonitor}
              onCheckedChange={(value) => updateField("autoResumeLastMonitor", value)}
            />
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Notifications" description="Control when ScreenLink notifies you">
        <Card>
          <CardContent className="pt-4 space-y-1">
            <SwitchRow
              id="notifications-enabled"
              label="General notifications enabled"
              checked={form.notificationsEnabled}
              onCheckedChange={(value) => updateField("notificationsEnabled", value)}
            />
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Host quality limits" description="Maximum stream quality caps. Applied as a ceiling to all presets and viewer requests.">
        <Card>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="max-video-bitrate">Maximum bitrate</Label>
              <Input
                id="max-video-bitrate"
                type="number"
                min={0}
                value={form.maxVideoBitrateKbps}
                onChange={(e) => updateField("maxVideoBitrateKbps", parseInt(e.target.value || "0", 10) || 0)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="max-width">Maximum width</Label>
              <Input
                id="max-width"
                type="number"
                min={0}
                value={form.maxWidth}
                onChange={(e) => updateField("maxWidth", parseInt(e.target.value || "0", 10) || 0)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="max-height">Maximum height</Label>
              <Input
                id="max-height"
                type="number"
                min={0}
                value={form.maxHeight}
                onChange={(e) => updateField("maxHeight", parseInt(e.target.value || "0", 10) || 0)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="max-fps">Maximum FPS</Label>
              <Input
                id="max-fps"
                type="number"
                min={0}
                value={form.maxFps}
                onChange={(e) => updateField("maxFps", parseInt(e.target.value || "0", 10) || 0)}
                disabled={saving}
              />
            </div>
          </div>
          <Separator />
          <SwitchRow
            id="allow-viewer-quality-requests"
            label="Allow viewer quality requests"
            checked={form.allowViewerQualityRequests}
            onCheckedChange={(value) => updateField("allowViewerQualityRequests", value)}
          />
        </CardContent>
      </Card>
      </PageSection>

      <PageSection title="Viewer bitrate slider cap" description="Maximum bitrate visible on the viewer quality slider">
        <Card>
          <CardContent className="pt-4 space-y-1.5">
            <Label htmlFor="viewer-bitrate-slider-max">
              Maximum bitrate (kbps) shown on the viewer quality slider
            </Label>
            <Input
              id="viewer-bitrate-slider-max"
              type="number"
              min={100}
              max={100000}
              value={form.viewerBitrateSliderMaxKbps}
              onChange={(e) => updateField("viewerBitrateSliderMaxKbps", parseInt(e.target.value || "0", 10) || 0)}
              disabled={saving}
            />
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Max viewer volume" description="Maximum volume boost for the viewer">
        <Card>
          <CardContent className="pt-4 space-y-1.5">
            <Label htmlFor="viewer-max-volume">
              Maximum volume percentage shown on the viewer volume slider
            </Label>
            <Input
              id="viewer-max-volume"
              type="number"
              min={1}
              max={500}
              value={form.viewerMaxVolumePercent}
              onChange={(e) => updateField("viewerMaxVolumePercent", parseInt(e.target.value || "0", 10) || 0)}
              disabled={saving}
            />
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Hourly usage estimate window" description="Time window for bandwidth graph hourly estimate">
        <Card>
          <CardContent className="pt-4 space-y-1.5">
            <Label htmlFor="hourly-estimate-window">
              Time window used to compute the bandwidth graph's hourly usage estimate
            </Label>
            <Select
              value={String(form.hourlyEstimateDurationMs)}
              onValueChange={(value) => updateField("hourlyEstimateDurationMs", Number(value))}
            >
              <SelectTrigger id="hourly-estimate-window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10000">Last 10 seconds</SelectItem>
                <SelectItem value="30000">Last 30 seconds</SelectItem>
                <SelectItem value="60000">Last 1 minute</SelectItem>
                <SelectItem value="300000">Last 5 minutes</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Streaming default" description="Default codec for new streams">
        <Card>
          <CardContent className="pt-4 space-y-1.5">
            <Label htmlFor="default-codec">Default codec</Label>
            <Select
              value={form.defaultCodec}
              onValueChange={(value) => updateField("defaultCodec", value as SettingsForm["defaultCodec"])}
            >
              <SelectTrigger id="default-codec">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODEC_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Viewer" description="Controls and features available while watching a stream">
        <Card>
          <CardContent className="pt-4 space-y-1">
            <SwitchRow
              id="show-compare-controls"
              label="Show A/B comparison controls"
              checked={form.showCompareControls}
              onCheckedChange={(value) => updateField("showCompareControls", value)}
            />
            <p className="text-xs text-text-muted pt-1">
              When enabled, a button and keyboard shortcuts (C, V, Alt+1/2/0) allow comparing
              two GPU enhancement configurations side by side.
            </p>
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Updates" description="Application update management">
        <Card>
          <CardContent className="pt-4">
            <UpdatesSettingsSection />
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Quick Share" description="One-click sharing with keyboard shortcuts">
        <Card>
          <CardContent className="pt-4 space-y-3">
            <SwitchRow
              id="quick-share-enabled"
              label="Enabled"
              checked={form.quickShareEnabled}
              onCheckedChange={(value) => updateField("quickShareEnabled", value)}
            />
            <div className="space-y-1.5">
              <Label htmlFor="quick-share-accelerator">Accelerator</Label>
              <KeyRecorder
                value={form.quickShareAccelerator}
                onChange={(v) => updateField("quickShareAccelerator", v)}
                disabled={saving}
              />
            </div>
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Discord Controls" description="Simulate Discord global keybinds via Win32 SendInput. Discord must have matching global shortcuts configured.">
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="discord-mute-shortcut">Mute shortcut</Label>
              <KeyRecorder
                value={form.discordMuteShortcut}
                onChange={(v) => updateField("discordMuteShortcut", v)}
                disabled={saving}
                placeholder="Alt+M"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-deafen-shortcut">Deafen shortcut</Label>
              <KeyRecorder
                value={form.discordDeafenShortcut}
                onChange={(v) => updateField("discordDeafenShortcut", v)}
                disabled={saving}
                placeholder="Alt+D"
              />
            </div>
            <Separator />
            <SwitchRow
              id="discord-deafen-screenlink"
              label="Also deafen ScreenLink share audio"
              checked={form.discordDeafenScreenLink}
              onCheckedChange={(value) => updateField("discordDeafenScreenLink", value)}
            />
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title="Stream Info Overlay" description="On-screen data overlay shown while viewing a stream">
        <Card>
        <CardContent className="pt-4 space-y-4">
          <p className="text-xs text-text-muted">
            Configure the on-screen data overlay shown in the top-left corner while viewing a stream.
          </p>
          <Separator />
          <SwitchRow
            id="sic-visible"
            label="Show overlay by default"
            checked={form.streamInfoCardVisible}
            onCheckedChange={(value) => updateField("streamInfoCardVisible", value)}
          />
          <Separator />
          <div className="space-y-2">
            <Label className="text-sm text-text-primary">Visible metrics</Label>
            <SwitchRow
              id="sic-resolution"
              label="Resolution"
              checked={form.streamInfoCardShowResolution}
              onCheckedChange={(value) => updateField("streamInfoCardShowResolution", value)}
            />
            <SwitchRow
              id="sic-fps"
              label="FPS"
              checked={form.streamInfoCardShowFps}
              onCheckedChange={(value) => updateField("streamInfoCardShowFps", value)}
            />
            <SwitchRow
              id="sic-bitrate"
              label="Bitrate"
              checked={form.streamInfoCardShowBitrate}
              onCheckedChange={(value) => updateField("streamInfoCardShowBitrate", value)}
            />
            <SwitchRow
              id="sic-dropped"
              label="Dropped frames"
              checked={form.streamInfoCardShowDroppedFrames}
              onCheckedChange={(value) => updateField("streamInfoCardShowDroppedFrames", value)}
            />
            <SwitchRow
              id="sic-network"
              label="Network usage"
              checked={form.streamInfoCardShowNetworkUsage}
              onCheckedChange={(value) => updateField("streamInfoCardShowNetworkUsage", value)}
            />
          </div>
          <Separator />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="sic-font-size">Font size (px)</Label>
              <Input
                id="sic-font-size"
                type="number"
                min={8}
                max={32}
                value={form.streamInfoCardFontSize}
                onChange={(e) => updateField("streamInfoCardFontSize", parseInt(e.target.value || "12", 10) || 12)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sic-box-width">Box width (px)</Label>
              <Input
                id="sic-box-width"
                type="number"
                min={100}
                max={600}
                value={form.streamInfoCardBoxWidth}
                onChange={(e) => updateField("streamInfoCardBoxWidth", parseInt(e.target.value || "200", 10) || 200)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sic-box-opacity">Background opacity (0-100)</Label>
              <Input
                id="sic-box-opacity"
                type="number"
                min={0}
                max={100}
                value={form.streamInfoCardBoxOpacity}
                onChange={(e) => updateField("streamInfoCardBoxOpacity", parseInt(e.target.value || "60", 10) || 60)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sic-text-color">Text color</Label>
              <div className="flex gap-2 items-center">
                <Input
                  id="sic-text-color"
                  type="text"
                  value={form.streamInfoCardTextColor}
                  onChange={(e) => updateField("streamInfoCardTextColor", e.target.value)}
                  placeholder="#ffffff"
                  disabled={saving}
                  className="flex-1"
                />
                <input
                  type="color"
                  value={form.streamInfoCardTextColor}
                  onChange={(e) => updateField("streamInfoCardTextColor", e.target.value)}
                  className="w-9 h-9 rounded-md border border-white/10 cursor-pointer bg-transparent"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      </PageSection>

      <PageSection title="Past Streams" description="Stream history and bandwidth usage">
        <StreamHistorySection />
      </PageSection>
    </div>

      {/* Sticky save bar — always visible at the bottom */}
      <div className="flex-shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t border-border-subtle bg-surface-1">
        <span
          className={`text-[0.8125rem] transition-colors duration-150 ${
            isDirty ? "text-text-secondary" : "text-text-muted"
          }`}
        >
          {isDirty ? "Unsaved changes" : "All settings saved"}
        </span>
        <Button
          variant="default"
          size="default"
          disabled={!isDirty || saving}
          onClick={handleSave}
        >
          {saving ? "Saving\u2026" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}

