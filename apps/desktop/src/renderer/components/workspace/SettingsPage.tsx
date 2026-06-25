import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
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
import { useStore } from "@/stores/main-store";

/**
 * SettingsPage — Application settings (Section 16.7).
 *
 * Sections as Watermelon Cards:
 *   General       — display name, language, theme
 *   Sharing       — default preset, audio mode, codec, resolution, fps
 *   Startup & tray — launch at login, minimize to tray, auto-resume, close-to-tray
 *   Capture       — hardware accel, system audio toggle, viewer quality requests
 *   Updates       — channel, auto-install
 */
export function SettingsPage() {
  // ── General ─────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState("User");
  const [language, setLanguage] = useState("en");
  const [theme, setTheme] = useState("dark");

  // ── Sharing defaults ────────────────────────────────────────────
  const [defaultPreset, setDefaultPreset] = useState("balanced");
  const [defaultAudio, setDefaultAudio] = useState("application");
  const [defaultCodec, setDefaultCodec] = useState("h264");
  const [defaultResolution, setDefaultResolution] = useState("1920x1080");
  const [defaultFps, setDefaultFps] = useState(60);

  // ── Startup & tray ──────────────────────────────────────────────
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [autoResume, setAutoResume] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);

  // ── Capture ─────────────────────────────────────────────────────
  const [hardwareAccel, setHardwareAccel] = useState(true);
  const [showSystemAudio, setShowSystemAudio] = useState(false);
  const [allowViewerRequests, setAllowViewerRequests] = useState(true);

  // ── Updates ─────────────────────────────────────────────────────
  const [updateChannel, setUpdateChannel] = useState("stable");
  const [autoInstall, setAutoInstall] = useState(true);

  // ── Reset dialog ────────────────────────────────────────────────
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const handleReset = useCallback(() => {
    setDisplayName("User");
    setLanguage("en");
    setTheme("dark");
    setDefaultPreset("balanced");
    setDefaultAudio("application");
    setDefaultCodec("h264");
    setDefaultResolution("1920x1080");
    setDefaultFps(60);
    setLaunchAtLogin(false);
    setStartMinimized(false);
    setAutoResume(false);
    setCloseToTray(true);
    setHardwareAccel(true);
    setShowSystemAudio(false);
    setAllowViewerRequests(true);
    setUpdateChannel("stable");
    setAutoInstall(true);
    setResetDialogOpen(false);
    toast("Settings reset to defaults");
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
        <Label htmlFor={id} className="text-sm text-text-primary cursor-pointer">
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
      <Label htmlFor={id} className="text-sm text-text-primary flex-shrink-0">
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

  return (
    <div className="h-full overflow-auto p-5 space-y-5">
      {/* ─── Page header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Settings</h1>
        <Button variant="outline" size="sm" onClick={() => toast("Settings saved")}>
          Save settings
        </Button>
      </div>

      {/* ─── General ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="display-name" className="text-sm text-text-primary">
              Display name
            </Label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name shown to viewers"
            />
          </div>
          <SelectRow
            id="language"
            label="Language"
            value={language}
            options={[
              { value: "en", label: "English" },
              { value: "ja", label: "Japanese" },
              { value: "ko", label: "Korean" },
            ]}
            onValueChange={setLanguage}
          />
          <SelectRow
            id="theme"
            label="Theme"
            value={theme}
            options={[
              { value: "system", label: "System" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onValueChange={setTheme}
          />
        </CardContent>
      </Card>

      {/* ─── Sharing defaults ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Sharing defaults</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0">
            <SelectRow
              id="default-preset"
              label="Default quality preset"
              value={defaultPreset}
              options={[
                { value: "data-saver", label: "Data saver" },
                { value: "balanced", label: "Balanced" },
                { value: "clear", label: "Clear" },
                { value: "custom", label: "Custom" },
              ]}
              onValueChange={setDefaultPreset}
            />
            <SelectRow
              id="default-audio"
              label="Default audio mode"
              value={defaultAudio}
              options={[
                { value: "none", label: "No audio" },
                { value: "application", label: "Application audio" },
                { value: "system", label: "System audio" },
              ]}
              onValueChange={setDefaultAudio}
            />
            <SelectRow
              id="default-codec"
              label="Default codec"
              value={defaultCodec}
              options={[
                { value: "h264", label: "H264" },
                { value: "vp8", label: "VP8" },
                { value: "vp9", label: "VP9" },
              ]}
              onValueChange={setDefaultCodec}
            />
            <SelectRow
              id="default-resolution"
              label="Default resolution"
              value={defaultResolution}
              options={[
                { value: "3840x2160", label: "3840×2160 (4K)" },
                { value: "2560x1440", label: "2560×1440 (1440p)" },
                { value: "1920x1080", label: "1920×1080 (1080p)" },
                { value: "1280x720", label: "1280×720 (720p)" },
                { value: "854x480", label: "854×480 (480p)" },
              ]}
              onValueChange={setDefaultResolution}
            />
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="default-fps" className="text-sm text-text-primary">
                Default FPS
              </Label>
              <Input
                id="default-fps"
                type="number"
                value={defaultFps}
                onChange={(e) => setDefaultFps(parseInt(e.target.value, 10) || 30)}
                min={1}
                max={120}
              />
            </div>
          </div>
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
            checked={launchAtLogin}
            onCheckedChange={setLaunchAtLogin}
          />
          <Separator />
          <SwitchRow
            id="start-minimized"
            label="Start minimized to tray"
            tooltip="When launched at login, ScreenLink starts in the system tray instead of showing the window."
            checked={startMinimized}
            onCheckedChange={setStartMinimized}
          />
          <Separator />
          <SwitchRow
            id="auto-resume"
            label="Auto-resume last monitor share"
            tooltip="On startup, automatically resume sharing your last-used monitor without confirmation."
            checked={autoResume}
            onCheckedChange={setAutoResume}
          />
          <Separator />
          <SwitchRow
            id="close-to-tray"
            label="Close to tray (when X clicked)"
            tooltip="Pressing the close button minimizes ScreenLink to the system tray instead of quitting."
            checked={closeToTray}
            onCheckedChange={setCloseToTray}
          />
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
            checked={hardwareAccel}
            onCheckedChange={setHardwareAccel}
          />
          <Separator />
          <SwitchRow
            id="show-system-audio"
            label="Show system audio toggle"
            tooltip="Show a toggle in the sharing UI to enable or disable system audio capture."
            checked={showSystemAudio}
            onCheckedChange={setShowSystemAudio}
          />
          <Separator />
          <SwitchRow
            id="allow-viewer-requests"
            label="Allow viewer quality requests"
            tooltip="Allow viewers to request quality changes to your stream. Disable to always use your preset."
            checked={allowViewerRequests}
            onCheckedChange={setAllowViewerRequests}
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
            value={updateChannel}
            options={[
              { value: "stable", label: "Stable" },
              { value: "beta", label: "Beta" },
            ]}
            onValueChange={setUpdateChannel}
          />
          <SwitchRow
            id="auto-install"
            label="Auto-install updates"
            tooltip="Automatically download and install updates when available. You will be prompted to restart."
            checked={autoInstall}
            onCheckedChange={setAutoInstall}
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
              This will reset all settings to their factory defaults. This action cannot be undone.
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
