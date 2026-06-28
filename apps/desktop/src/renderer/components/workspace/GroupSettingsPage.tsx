import { useState, useCallback, useEffect, useRef } from "react";
import {
  Copy,
  LogOut,
  Bell,
  Users,
  Info,
  Keyboard,
  Monitor,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { KeyRecorder } from "@/components/ui/key-recorder";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { useStore } from "@/stores/main-store";
import { setGroupNotifications } from "@/services/settings-actions";
import { leaveGroupAction } from "@/services/group-leave-action";
import { copyGroupInviteFromUi } from "@/services/invite-copy";
import type {
  GroupShortcutConfigDTO,
  CaptureSourceDTO,
  ShortcutValidationDTO,
} from "../../../preload/api-types.js";

/**
 * Get the preload API, returning null when unavailable.
 */
function getApi() {
  try {
    return (window as unknown as {
      screenlink?: {
        getGroupShortcutConfig: (id: string) => Promise<GroupShortcutConfigDTO>;
        updateGroupShortcutConfig: (id: string, c: Partial<GroupShortcutConfigDTO>) => Promise<GroupShortcutConfigDTO>;
        validateGroupShortcut: (s: string, g: string, a: string, e?: boolean) => Promise<ShortcutValidationDTO>;
        getSources: () => Promise<CaptureSourceDTO[]>;
        listQualityPresets: () => Promise<Array<{ id: string; name: string }>>;
      };
    }).screenlink ?? null;
  } catch {
    return null;
  }
}

/**
 * GroupSettingsPage — Group-owned settings surface (Section 6.2).
 *
 * Controls:
 *  - Group info (name + member count)
 *  - Copy invite link
 *  - Notification toggle (real preload)
 *  - Leave group
 *  - Quick Actions: per-group global keyboard shortcuts for Quick Share
 *    and Quick Join, configured source, and default preset.
 */
export function GroupSettingsPage() {
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
  const navigate = useStore((s) => s.navigate);

  const group = selectedGroupId ? groupsById[selectedGroupId] : null;
  const memberCount = group ? Object.keys(group.members).length : 0;

  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // ── Quick Actions state ──────────────────────────────────────────────
  const [shortcutConfig, setShortcutConfig] = useState<GroupShortcutConfigDTO | null>(null);
  const [sources, setSources] = useState<CaptureSourceDTO[]>([]);
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [savingQuickShare, setSavingQuickShare] = useState(false);
  const [savingQuickJoin, setSavingQuickJoin] = useState(false);

  const prevGroupIdRef = useRef<string | null>(null);

  // Load shortcut config, sources, and presets when group changes
  useEffect(() => {
    if (!selectedGroupId) return;
    if (prevGroupIdRef.current === selectedGroupId) return;
    prevGroupIdRef.current = selectedGroupId;

    const api = getApi();
    if (!api) return;

    setConfigLoading(true);
    Promise.all([
      api.getGroupShortcutConfig(selectedGroupId).then(setShortcutConfig).catch(() => {}),
      api.getSources().then(setSources).catch(() => {}),
      api.listQualityPresets().then(setPresets).catch(() => {}),
    ]).finally(() => setConfigLoading(false));
  }, [selectedGroupId]);

  const quickShareError = shortcutConfig?.quickShareShortcut ? "" : "";
  const quickJoinError = shortcutConfig?.quickJoinShortcut ? "" : "";

  // ── Validate and save Quick Share shortcut ──────────────────────────
  const handleQuickShareShortcutChange = useCallback(
    async (value: string) => {
      if (!selectedGroupId) return;
      const api = getApi();
      if (!api) return;

      setSavingQuickShare(true);
      try {
        // Validate first
        const validation = await api.validateGroupShortcut(
          value,
          selectedGroupId,
          "quick-share",
          true,
        );
        if (!validation.valid) {
          toast.error(validation.error ?? "Invalid shortcut combination");
          return;
        }

        // Save
        const updated = await api.updateGroupShortcutConfig(selectedGroupId, {
          quickShareShortcut: value,
        });
        setShortcutConfig(updated);
        toast.success("Quick Share shortcut saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save shortcut");
      } finally {
        setSavingQuickShare(false);
      }
    },
    [selectedGroupId],
  );

  // ── Clear Quick Share shortcut ──────────────────────────────────────
  const handleClearQuickShareShortcut = useCallback(async () => {
    if (!selectedGroupId) return;
    const api = getApi();
    if (!api) return;

    setSavingQuickShare(true);
    try {
      const updated = await api.updateGroupShortcutConfig(selectedGroupId, {
        quickShareShortcut: null,
      });
      setShortcutConfig(updated);
      toast.success("Quick Share shortcut cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear shortcut");
    } finally {
      setSavingQuickShare(false);
    }
  }, [selectedGroupId]);

  // ── Validate and save Quick Join shortcut ──────────────────────────
  const handleQuickJoinShortcutChange = useCallback(
    async (value: string) => {
      if (!selectedGroupId) return;
      const api = getApi();
      if (!api) return;

      setSavingQuickJoin(true);
      try {
        const validation = await api.validateGroupShortcut(
          value,
          selectedGroupId,
          "quick-join",
          true,
        );
        if (!validation.valid) {
          toast.error(validation.error ?? "Invalid shortcut combination");
          return;
        }

        const updated = await api.updateGroupShortcutConfig(selectedGroupId, {
          quickJoinShortcut: value,
        });
        setShortcutConfig(updated);
        toast.success("Quick Join shortcut saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save shortcut");
      } finally {
        setSavingQuickJoin(false);
      }
    },
    [selectedGroupId],
  );

  // ── Clear Quick Join shortcut ──────────────────────────────────────
  const handleClearQuickJoinShortcut = useCallback(async () => {
    if (!selectedGroupId) return;
    const api = getApi();
    if (!api) return;

    setSavingQuickJoin(true);
    try {
      const updated = await api.updateGroupShortcutConfig(selectedGroupId, {
        quickJoinShortcut: null,
      });
      setShortcutConfig(updated);
      toast.success("Quick Join shortcut cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear shortcut");
    } finally {
      setSavingQuickJoin(false);
    }
  }, [selectedGroupId]);

  // ── Save Quick Share source ───────────────────────────────────────
  const handleQuickShareSourceChange = useCallback(
    async (sourceId: string) => {
      if (!selectedGroupId) return;
      const api = getApi();
      if (!api) return;

      const source = sources.find((s) => s.id === sourceId);
      if (!source) return;

      try {
        const updated = await api.updateGroupShortcutConfig(selectedGroupId, {
          quickShareSource: {
            id: source.id,
            name: source.name,
            kind: source.kind,
            displayId: source.displayId,
          },
        });
        setShortcutConfig(updated);
        toast.success("Quick Share source updated");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save source");
      }
    },
    [selectedGroupId, sources],
  );

  // ── Save Quick Share default preset ───────────────────────────────
  const handleQuickSharePresetChange = useCallback(
    async (presetId: string) => {
      if (!selectedGroupId) return;
      const api = getApi();
      if (!api) return;

      try {
        const updated = await api.updateGroupShortcutConfig(selectedGroupId, {
          quickShareDefaultPresetId: presetId === "__none" ? null : presetId,
        });
        setShortcutConfig(updated);
        toast.success("Default preset updated");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save preset");
      }
    },
    [selectedGroupId],
  );

  // ── Copy invite link ────────────────────────────────────────────
  const handleCopyInviteLink = useCallback(async () => {
    if (!selectedGroupId) return;
    await copyGroupInviteFromUi(selectedGroupId, "Invite link copied");
  }, [selectedGroupId]);

  // ── Notification toggle (real) ──────────────────────────────────
  const handleNotificationToggle = useCallback(
    async (enabled: boolean) => {
      if (!selectedGroupId) return;
      setNotificationSaving(true);
      try {
        await setGroupNotifications(selectedGroupId, enabled);
        setNotificationsEnabled(enabled);
        toast.success(
          enabled
            ? "Notifications enabled for this group"
            : "Notifications disabled for this group",
        );
      } catch {
        toast.error("Failed to update notification settings");
      } finally {
        setNotificationSaving(false);
      }
    },
    [selectedGroupId],
  );

  // ── Leave group (real) ──────────────────────────────────────────
  const handleLeaveGroup = useCallback(async () => {
    if (!selectedGroupId) return;
    setLeaving(true);
    const result = await leaveGroupAction(selectedGroupId);
    setLeaving(false);
    setLeaveConfirmOpen(false);
    if (result.success) {
      toast.success("Left group");
      const stillSelected = useStore.getState().selectedGroupId === selectedGroupId;
      if (stillSelected) {
        navigate("home");
      }
    } else if (result.localOnly) {
      toast.error("Leave Group is not yet supported in this build");
    } else {
      toast.error(result.error ?? "Failed to leave group");
    }
  }, [selectedGroupId, navigate]);

  // ── No group selected ───────────────────────────────────────────
  if (!group) {
    return (
      <div className="h-full overflow-auto p-6">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="flex items-center justify-center h-12 w-12 rounded-dialog bg-surface-3">
              <Users className="h-6 w-6 text-text-muted" />
            </div>
            <p className="text-sm text-text-secondary">
              Select a group to view its settings.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Derive source/preset display values ─────────────────────────
  const selectedSourceId = shortcutConfig?.quickShareSource?.id ?? "__none";
  const selectedPresetId = shortcutConfig?.quickShareDefaultPresetId ?? "__none";
  const filteredSources = sources.filter((s) => s.kind === "screen" || s.kind === "window");

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <h1 className="text-xl font-semibold text-text-primary">
        Group settings
      </h1>

      {/* ─── Group info ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-4 w-4" />
            Group info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs text-text-muted block">Name</Label>
            <span className="text-sm text-text-primary font-medium">
              {group.name}
            </span>
          </div>
          <div>
            <Label className="text-xs text-text-muted block">Members</Label>
            <span className="text-sm text-text-primary">
              {memberCount} {memberCount === 1 ? "member" : "members"}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ─── Actions ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Actions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={handleCopyInviteLink}
          >
            <Copy className="h-4 w-4 mr-2" />
            Copy invite link
          </Button>

          <Separator />

          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-text-muted" />
              <Label
                htmlFor="group-notifications"
                className="text-sm text-text-primary cursor-pointer"
              >
                Notifications
              </Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-surface-3 text-[10px] text-text-muted cursor-help">
                    ?
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  Receive notifications for this group (member joins, stream
                  activity).
                </TooltipContent>
              </Tooltip>
            </div>
            <Switch
              id="group-notifications"
              checked={notificationsEnabled}
              onCheckedChange={handleNotificationToggle}
              disabled={notificationSaving}
              aria-label="Toggle group notifications"
            />
          </div>

          <Separator />

          <Button
            variant="destructive"
            className="w-full justify-start"
            onClick={() => setLeaveConfirmOpen(true)}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Leave group
          </Button>
        </CardContent>
      </Card>

      {/* ─── Quick Actions ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Quick Actions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {configLoading && (
            <p className="text-sm text-text-muted">Loading configuration...</p>
          )}

          {!configLoading && (
            <>
              {/* ── Quick Share ────────────────────────────────── */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Quick Share</Label>
                  <Badge variant="outline" className="text-[10px]">
                    {shortcutConfig?.quickShareShortcut ? "Configured" : "Not set"}
                  </Badge>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-text-muted">Shortcut</Label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <KeyRecorder
                        value={shortcutConfig?.quickShareShortcut ?? ""}
                        onChange={handleQuickShareShortcutChange}
                        disabled={savingQuickShare}
                        placeholder="Click to set shortcut"
                      />
                    </div>
                    {shortcutConfig?.quickShareShortcut && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0"
                        onClick={handleClearQuickShareShortcut}
                        disabled={savingQuickShare}
                        title="Clear shortcut"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-text-muted">Source</Label>
                  <Select
                    value={selectedSourceId}
                    onValueChange={handleQuickShareSourceChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none" disabled>
                        Select a source...
                      </SelectItem>
                      {filteredSources.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          <span className="flex items-center gap-2">
                            <Monitor className="h-3.5 w-3.5" />
                            {s.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-text-muted">
                    Default Preset
                  </Label>
                  <Select
                    value={selectedPresetId}
                    onValueChange={handleQuickSharePresetChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a preset" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">No preset (use defaults)</SelectItem>
                      {presets.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              {/* ── Quick Join ─────────────────────────────────── */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Quick Join</Label>
                  <Badge variant="outline" className="text-[10px]">
                    {shortcutConfig?.quickJoinShortcut ? "Configured" : "Not set"}
                  </Badge>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-text-muted">Shortcut</Label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <KeyRecorder
                        value={shortcutConfig?.quickJoinShortcut ?? ""}
                        onChange={handleQuickJoinShortcutChange}
                        disabled={savingQuickJoin}
                        placeholder="Click to set shortcut"
                      />
                    </div>
                    {shortcutConfig?.quickJoinShortcut && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0"
                        onClick={handleClearQuickJoinShortcut}
                        disabled={savingQuickJoin}
                        title="Clear shortcut"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ─── Leave group confirmation dialog ─────────────────── */}
      <Dialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Leave group</DialogTitle>
            <DialogDescription>
              Are you sure you want to leave{" "}
              <span className="font-medium text-text-primary">
                {group.name}
              </span>
              ? You'll need a new invite to rejoin.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={leaving}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleLeaveGroup}
              disabled={leaving}
            >
              <LogOut className="h-4 w-4" />
              {leaving ? "Leaving\u2026" : "Leave"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
