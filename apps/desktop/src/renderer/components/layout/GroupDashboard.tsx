import { useState, useCallback } from "react";
import {
  LayoutDashboard,
  Radio,
  Users,
  SlidersHorizontal,
  Settings,
  ChevronDown,
  Copy,
  LogOut,
  Bell,
  UserPlus,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useStore, type GroupNavPage } from "@/stores/main-store";
import { UserDock } from "./UserDock.js";
import { AnimatedCountBadge } from "@/components/primitives/AnimatedCountBadge";
import { InviteDialog } from "@/components/workspace/InviteDialog";

/**
 * GroupDashboard — 240px column for the selected group (Section 6).
 *
 * Composed entirely from Watermelon primitives:
 *  - Avatar (group icon)
 *  - Badge (member count, live badges)
 *  - Button (nav items)
 *  - DropdownMenu (header menu)
 *  - ScrollArea (scrollable content)
 *  - Tooltip (truncated labels)
 *  - motion/AnimatePresence (animated selection indicator, active shares)
 *
 * Sections:
 *  - Header: avatar + name + member count + overflow menu
 *  - Navigation: Overview / Active shares / Members / Presets / Group settings
 *  - Active shares list (compact)
 *  - User/Status dock (user-dock component) at the bottom
 */
export function GroupDashboard() {
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
  const groupNavPage = useStore((s) => s.groupNavPage);
  const setGroupNavPage = useStore((s) => s.setGroupNavPage);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const navigate = useStore((s) => s.navigate);

  const group = selectedGroupId ? groupsById[selectedGroupId] : null;
  const memberCount = group
    ? Object.keys(group.members).length
    : 0;
  const activeShares = selectedGroupId
    ? (activeStreamsByGroup[selectedGroupId] ?? [])
    : [];

  // ── Dialog/sheet state ────────────────────────────────────────────
  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  const initials = (name: string) =>
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();

  // ── Menu action handlers (Section 6.1 / 3.7C) ────────────────────

  const handleInviteMembers = useCallback(() => {
    if (selectedGroupId) {
      setInviteOpen(true);
    }
  }, [selectedGroupId]);

  const handleCopyInviteLink = useCallback(async () => {
    if (!selectedGroupId) return;
    try {
      await navigator.clipboard.writeText(
        `https://screenlink.app/invite/${selectedGroupId}`,
      );
      toast("Invite link copied");
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = `https://screenlink.app/invite/${selectedGroupId}`;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast("Invite link copied");
    }
  }, [selectedGroupId]);

  const handleNotificationSettings = useCallback(() => {
    toast("Notification settings coming soon");
  }, []);

  const handleLeaveGroup = useCallback(() => {
    setLeaveConfirmOpen(true);
  }, []);

  const handleConfirmLeave = useCallback(() => {
    // For now, hide the group via local state — full leave flow out of scope
    toast("Left group (local state only — full leave flow coming in a later stage)");
    setLeaveConfirmOpen(false);
  }, []);

  const navItems: {
    id: GroupNavPage;
    label: string;
    icon: React.ReactNode;
  }[] = [
    { id: "overview", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" /> },
    { id: "active-shares", label: "Active shares", icon: <Radio className="h-4 w-4" /> },
    { id: "members", label: "Members", icon: <Users className="h-4 w-4" /> },
    { id: "presets", label: "Presets", icon: <SlidersHorizontal className="h-4 w-4" /> },
    { id: "group-settings", label: "Group settings", icon: <Settings className="h-4 w-4" /> },
  ];

  return (
    <div className="flex flex-col w-[240px] flex-shrink-0 bg-surface-1 border-r border-border-subtle">
      {/* ─── Header (Section 6.1) ─────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-subtle">
        {group ? (
          <>
            <Avatar className="h-8 w-8 rounded-lg flex-shrink-0">
              <AvatarFallback className="rounded-lg bg-surface-3 text-xs font-semibold">
                {initials(group.name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="block text-sm font-semibold text-text-primary truncate">
                    {group.name}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{group.name}</TooltipContent>
              </Tooltip>
              <span className="block text-[11px] text-text-muted leading-tight">
                {memberCount} {memberCount === 1 ? "member" : "members"}
              </span>
            </div>

            {/* Overflow menu */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 flex-shrink-0"
                      aria-label="Group menu"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Group menu</TooltipContent>
              </Tooltip>

              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem onClick={handleInviteMembers}>
                  <UserPlus className="h-4 w-4" />
                  Invite members
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleCopyInviteLink}>
                  <Copy className="h-4 w-4" />
                  Copy invite link
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setGroupNavPage("group-settings")}
                >
                  <Settings className="h-4 w-4" />
                  Group settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleNotificationSettings}>
                  <Bell className="h-4 w-4" />
                  Notification settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-danger"
                  onClick={handleLeaveGroup}
                >
                  <LogOut className="h-4 w-4" />
                  Leave group
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <span className="text-sm text-text-muted px-1">No group selected</span>
        )}
      </div>

      {/* ─── No group selected empty state ─────────────────── */}
      {!group ? (
        <div className="flex flex-col items-center text-center px-4 py-6 gap-3">
          <div className="flex items-center justify-center h-10 w-10 rounded-dialog bg-surface-3">
            <Users className="h-5 w-5 text-text-muted" />
          </div>
          <p className="text-sm text-text-secondary">
            Select or create a group
          </p>
          <div className="flex flex-col gap-2 w-full max-w-[160px]">
            <Button size="sm" onClick={() => useStore.getState().navigate("groups")}>
              Create group
            </Button>
            <Button variant="outline" size="sm" onClick={() => useStore.getState().navigate("groups")}>
              Join group
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* ─── Primary nav (Section 6.2) ────────────────────── */}
          <nav className="px-2 py-2 space-y-0.5">
            {navItems.map((item) => {
              const isActive = groupNavPage === item.id;
              return (
                <button
                  key={item.id}
                  className={cn(
                    "relative flex items-center gap-2 w-full px-2 py-1.5 rounded-compact text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
                    isActive
                      ? "bg-accent-muted text-accent font-medium"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
                  )}
                  onClick={() => {
                    setGroupNavPage(item.id);
                  }}
                >
                  {/* Animated selection indicator */}
                  {isActive && (
                    <motion.div
                      layoutId="group-nav-indicator"
                      className="absolute inset-0 rounded-compact bg-accent-muted"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                  <span className="relative flex items-center gap-2 z-10">
                    {item.icon}
                    <span>{item.label}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          {/* ─── Active shares list (Section 6.3) ─────────────── */}
          {activeShares.length > 0 && (
            <div className="px-2 py-1 border-t border-border-subtle">
              <div className="flex items-center gap-1.5 px-2 py-1">
                <Radio className="h-3 w-3 text-accent" />
                <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                  Active shares
                </span>
                <AnimatedCountBadge
                  count={activeShares.length}
                  variant="default"
                  className="ml-auto text-[10px] px-1.5 py-0"
                />
              </div>
              <ScrollArea className="max-h-[240px]">
                <div className="space-y-0.5 pr-1">
                  <AnimatePresence mode="popLayout">
                    {activeShares.map((share) => (
                      <motion.div
                        key={share.logicalStreamId}
                        layout
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-compact hover:bg-surface-hover cursor-pointer"
                      >
                        <Avatar className="h-6 w-6 rounded-md flex-shrink-0">
                          <AvatarFallback className="rounded-md text-[10px] bg-surface-3">
                            {initials(share.hostDisplayName)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <span className="block text-xs text-text-primary truncate">
                            {share.hostDisplayName}
                          </span>
                          <span className="block text-[10px] text-text-muted truncate">
                            {share.sourceName}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-success" />
                          <span className="text-[10px] text-text-muted">
                            {share.sourceKind}
                          </span>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </ScrollArea>
            </div>
          )}
        </>
      )}

      {/* ─── Invite dialog ────────────────────────────────── */}
      {group && selectedGroupId && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          groupName={group.name}
          groupId={selectedGroupId}
        />
      )}

      {/* ─── Leave group confirm dialog ────────────────────── */}
      <Dialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Leave group</DialogTitle>
            <DialogDescription>
              Are you sure you want to leave{" "}
              <span className="font-medium text-text-primary">
                {group?.name ?? "this group"}
              </span>
              ? You'll need a new invite to rejoin.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleConfirmLeave}
            >
              <LogOut className="h-4 w-4" />
              Leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Spacer ───────────────────────────────────────── */}
      <div className="flex-1" />

      {/* ─── User dock (Section 7) ────────────────────────── */}
      <UserDock />
    </div>
  );
}
