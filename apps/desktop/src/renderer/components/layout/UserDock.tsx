import { useState, useCallback, useEffect } from "react";
import { Settings, MoreHorizontal, Wifi, WifiOff, Monitor, Eye, Loader2, RefreshCw, Download } from "lucide-react";
// Monitor is used in the overflow menu for "Start sharing"
import { motion, AnimatePresence } from "motion/react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn, getInitials } from "@/lib/utils";
import { useStore } from "@/stores/main-store";
import { SettingsSheet } from "@/components/workspace/SettingsSheet";

/**
 * User dock status states (Section 7.1).
 */
export type UserStatus =
  | "Ready"
  | "Sharing"
  | "Watching"
  | "Connecting"
  | "Reconnecting"
  | "Offline"
  | "Update available";

/**
 * UserDock — Bottom-left user/status dock (Section 7).
 *
 * Composed entirely from Watermelon primitives:
 *  - Avatar (initials fallback)
 *  - Button (settings, overflow)
 *  - Tooltip (on icon buttons)
 *  - DropdownMenu (overflow: diagnostics, quit, etc.)
 *  - Sheet (settings panel)
 *  - Switch (launch at login, auto-resume)
 *  - motion/AnimatePresence (status text transitions)
 */
export function UserDock() {
  const [userStatus, setUserStatus] = useState<UserStatus>("Ready");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [autoResume, setAutoResume] = useState(false);
  const [displayName, setDisplayName] = useState("User");

  useEffect(() => {
    const api = (window as unknown as { screenlink?: import("../../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    if (!api) return;
    void api.getSettings().then((settings) => {
      setDisplayName(settings.hostDisplayName ?? settings.deviceIdentity?.displayName ?? "User");
      setLaunchAtLogin(settings.launchAtLogin ?? false);
      setAutoResume(settings.autoResumeLastMonitor ?? false);
    }).catch(() => {});
  }, []);

  const statusConfig = useCallback((status: UserStatus) => {
    switch (status) {
      case "Ready":
        return { color: "bg-success", icon: <Wifi className="h-3 w-3" /> };
      case "Sharing":
        return { color: "bg-accent", icon: <Monitor className="h-3 w-3" /> };
      case "Watching":
        return { color: "bg-accent", icon: <Eye className="h-3 w-3" /> };
      case "Connecting":
        return { color: "bg-warning", icon: <Loader2 className="h-3 w-3 animate-spin" /> };
      case "Reconnecting":
        return { color: "bg-warning", icon: <RefreshCw className="h-3 w-3" /> };
      case "Offline":
        return { color: "bg-text-muted", icon: <WifiOff className="h-3 w-3" /> };
      case "Update available":
        return { color: "bg-accent", icon: <Download className="h-3 w-3" /> };
    }
  }, []);

  const status = statusConfig(userStatus);

  return (
    <div className="flex items-center gap-2 px-2 py-2 border-t border-border-subtle bg-surface-1">
      {/* ─── Avatar ────────────────────────────────────── */}
      <Avatar className="h-8 w-8 rounded-lg flex-shrink-0">
        <AvatarFallback className="rounded-lg text-xs font-semibold bg-surface-3">
          {getInitials(displayName, 1)}
        </AvatarFallback>
      </Avatar>

      {/* ─── Name + status ─────────────────────────────── */}
      <div className="flex-1 min-w-0">
        <span className="block text-xs font-medium text-text-primary truncate">
          {displayName}
        </span>
        <div className="flex items-center gap-1">
          <span
            className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", status.color)}
          />
          <AnimatePresence mode="wait">
            <motion.span
              key={userStatus}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="block text-[10px] text-text-muted leading-tight"
            >
              {userStatus}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      {/* ─── Settings button ───────────────────────────── */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>

      {/* ─── Settings sheet ─────────────────────────────── */}
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* ─── Overflow menu ─────────────────────────────── */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0"
                aria-label="More options"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">More options</TooltipContent>
        </Tooltip>

        <DropdownMenuContent side="top" align="end">
          <DropdownMenuItem
            onClick={() => {
              useStore.getState().setOpenShareSetup(true);
            }}
          >
            <Monitor className="h-4 w-4" />
            Start sharing
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              useStore.getState().navigate("diagnostics");
            }}
          >
            Diagnostics
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              /* TODO: check for updates */
            }}
          >
            Check for updates
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-sm text-text-primary">Launch at login</span>
            <Switch
              checked={launchAtLogin}
              onCheckedChange={(checked) => {
                setLaunchAtLogin(checked);
                const api = (window as unknown as { screenlink?: import("../../../preload/api-types.js").ScreenLinkAPI }).screenlink;
                if (api) {
                  void api.updateSettings({ launchAtLogin: checked }).catch(() => {});
                }
              }}
              aria-label="Toggle launch at login"
            />
          </div>
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-sm text-text-primary">Auto-resume last share</span>
            <Switch
              checked={autoResume}
              onCheckedChange={(checked) => {
                setAutoResume(checked);
                const api = (window as unknown as { screenlink?: import("../../../preload/api-types.js").ScreenLinkAPI }).screenlink;
                if (api) {
                  void api.updateSettings({ autoResumeLastMonitor: checked }).catch(() => {});
                }
              }}
              aria-label="Toggle auto-resume"
            />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-danger"
            onClick={() => {
              /* TODO: quit completely */
            }}
          >
            Quit completely
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
