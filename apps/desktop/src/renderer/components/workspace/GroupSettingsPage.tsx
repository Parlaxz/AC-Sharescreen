import { useState, useCallback } from "react";
import {
  Copy,
  LogOut,
  Bell,
  Users,
  Info,
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
import { useStore } from "@/stores/main-store";
import { setGroupNotifications } from "@/services/settings-actions";
import { leaveGroupAction } from "@/services/group-leave-action";
import { copyGroupInviteFromUi } from "@/services/invite-copy";

/**
 * GroupSettingsPage — Group-owned settings surface (Section 6.2).
 *
 * Only genuinely supported group-owned controls are shown:
 *  - Group info (name + member count)
 *  - Copy invite link
 *  - Notification toggle (real preload `setGroupNotifications`)
 *  - Leave group (real preload `leaveGroup` + state cleanup)
 *
 * No fake/unsupported controls. Notification settings
 * "coming soon" has been removed; the toggle is a real control.
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
      // The action's reducer already selected another group or
      // navigated to home; just ensure we land on a safe page if
      // we're still in this group.
      const stillSelected = useStore.getState().selectedGroupId === selectedGroupId;
      if (stillSelected) {
        navigate("home");
      }
    } else if (result.localOnly) {
      // No real leave API available — keep the action visible but
      // surface the limitation honestly.
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
              {leaving ? "Leaving…" : "Leave"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
