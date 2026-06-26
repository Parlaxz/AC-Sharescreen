import { useCallback } from "react";
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
import { cn, getInitials } from "@/lib/utils";
import { useStore } from "@/stores/main-store";
import { useIdentityStore } from "@/stores/identity-store";

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
  const displayName = useIdentityStore((s) => s.localDisplayName);
  const navigate = useStore((s) => s.navigate);
  const isSharing = useStore((s) => s.isSharing);
  const isViewing = useStore((s) => s.isViewing);
  const localShareState = useStore((s) => s.localShareState);
  const viewStatus = useStore((s) => s.viewStatus);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupConnectionStateById = useStore((s) => s.groupConnectionStateById);

  const userStatus: UserStatus = (() => {
    if (viewStatus === "reconnecting") return "Reconnecting";
    if (localShareState === "starting" || viewStatus === "connecting") {
      return "Connecting";
    }
    if (isSharing) return "Sharing";
    if (isViewing) return "Watching";
    const selectedConnectionState = selectedGroupId
      ? groupConnectionStateById[selectedGroupId]?.state
      : null;
    if (selectedConnectionState === "error" || selectedConnectionState === "disconnected") {
      return "Offline";
    }
    return "Ready";
  })();

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
    <div className="mt-auto flex items-center gap-2 px-2 py-2 border-t border-border-subtle bg-surface-1">
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
              onClick={() => navigate("user-settings")}
            >
              <Settings className="h-4 w-4" />
            </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>

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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
