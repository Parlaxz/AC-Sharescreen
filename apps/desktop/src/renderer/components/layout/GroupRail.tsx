import { useCallback, useState } from "react";
import { Plus, Home } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn, getInitials } from "@/lib/utils";
import { useStore } from "@/stores/main-store";
import { copyGroupInviteFromUi } from "@/services/invite-copy";

/**
 * GroupRail — 64px wide column of group icons (Section 5).
 *
 * Composed entirely from Watermelon primitives:
 *  - Avatar (48×48, rounded-square for groups)
 *  - Tooltip (on each group for name)
 *  - Button/IconButton (create/join action)
 *  - Badge (live-state indicator)
 *  - ContextMenu (right-click: copy invite)
 *  - motion (animated active indicator + live pulse ring)
 *
 * Connect to useStore: groupsById, groupOrder, selectedGroupId, setSelectedGroupId.
 *
 * Rename and Leave Group are intentionally removed: Rename is not
 * yet implemented (no fake "coming soon" placeholder) and Leave
 * Group lives on the Group Settings page only.
 */
export function GroupRail() {
  const groupsById = useStore((s) => s.groupsById);
  const groupOrder = useStore((s) => s.groupOrder);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const setSelectedGroupId = useStore((s) => s.setSelectedGroupId);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const navigate = useStore((s) => s.navigate);

  const setOpenCreateGroupDialog = useStore((s) => s.setOpenCreateGroupDialog);
  const setOpenJoinGroupDialog = useStore((s) => s.setOpenJoinGroupDialog);

  const handleGroupClick = useCallback(
    (groupId: string) => {
      setSelectedGroupId(groupId);
      navigate("overview");
    },
    [setSelectedGroupId, navigate],
  );

  const handleCopyInviteLink = useCallback(async (groupId: string) => {
    await copyGroupInviteFromUi(groupId, "Invite link copied");
  }, []);

  return (
    <div className="flex flex-col items-center w-16 h-full min-h-0 flex-shrink-0 bg-rail border-r border-border-subtle py-2 gap-1 overflow-x-hidden">
      {/* ─── Home/Product button ──────────────────────────── */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-lg text-text-secondary hover:text-text-primary flex-shrink-0"
            aria-label="Home"
            onClick={() => navigate("home")}
          >
            <Home className="h-5 w-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Home</TooltipContent>
      </Tooltip>

      {/* ─── Groups list ──────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col items-center gap-1 overflow-y-auto overflow-x-hidden py-1 w-full px-2 min-w-0">
        <AnimatePresence mode="popLayout">
          {groupOrder.map((groupId) => {
            const group = groupsById[groupId];
            if (!group) return null;
            const isSelected = groupId === selectedGroupId;
            const hasActiveStreams =
              (activeStreamsByGroup[groupId]?.length ?? 0) > 0;

            return (
              <ContextMenu key={groupId}>
                <ContextMenuTrigger asChild>
                  <div className="relative overflow-hidden">
                    {/* Active indicator bar — animated with layoutId */}
                    {isSelected && (
                      <motion.div
                        layoutId="group-rail-indicator"
                        className="absolute -left-2 top-1/2 -translate-y-1/2 w-1 h-6 rounded-r-full bg-accent"
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      />
                    )}

                    {/* Live-state ring */}
                    {hasActiveStreams && (
                      <motion.div
                        className="absolute -inset-0.5 rounded-xl border-2 border-accent/60"
                        initial={{ opacity: 0.6 }}
                        animate={{ opacity: 1 }}
                        transition={{
                          duration: 2,
                          ease: "easeOut",
                        }}
                      />
                    )}

                    {/* Group avatar/icon — 48×48 rounded squares */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className={cn(
                            "relative flex items-center justify-center w-12 h-12 rounded-xl overflow-hidden",
                            "transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                            isSelected
                              ? "bg-surface-3"
                              : "bg-surface-2 hover:bg-surface-hover",
                          )}
                          onClick={() => handleGroupClick(groupId)}
                          aria-label={`Group: ${group.name}`}
                          tabIndex={0}
                        >
                          <Avatar className="w-12 h-12 rounded-xl">
                            <AvatarFallback className="rounded-xl bg-inherit text-xs font-semibold">
                              {getInitials(group.name)}
                            </AvatarFallback>
                          </Avatar>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <div className="flex flex-col gap-0.5">
                          <span>{group.name}</span>
                          {hasActiveStreams && (
                            <span className="text-accent text-[10px]">
                              ● Live
                            </span>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </ContextMenuTrigger>

                {/* Context menu on right-click — only the real action */}
                <ContextMenuContent>
                  <ContextMenuItem
                    onClick={() => handleCopyInviteLink(groupId)}
                  >
                    Copy invite link
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </AnimatePresence>
      </div>

      {/* ─── Create/Join action ──────────────────────────── */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                aria-label="Create or join group"
              >
                <Plus className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">Create or join group</TooltipContent>
        </Tooltip>

        <DropdownMenuContent side="right" align="end">
          <DropdownMenuItem
            onClick={() => {
              setOpenCreateGroupDialog(true);
            }}
          >
            Create group
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setOpenJoinGroupDialog(true);
            }}
          >
            Join group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
