import { useCallback, useState } from "react";
import { Plus, Home } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";
import { useStore } from "@/stores/main-store";

/**
 * GroupRail — 64px wide column of group icons (Section 5).
 *
 * Composed entirely from Watermelon primitives:
 *  - Avatar (48×48, rounded-square for groups)
 *  - Tooltip (on each group for name)
 *  - Button/IconButton (create/join action)
 *  - Badge (live-state indicator)
 *  - ContextMenu (right-click: rename/leave/copy invite)
 *  - motion (animated active indicator + live pulse ring)
 *
 * Connect to useStore: groupsById, groupOrder, selectedGroupId, setSelectedGroupId.
 */
export function GroupRail() {
  const groupsById = useStore((s) => s.groupsById);
  const groupOrder = useStore((s) => s.groupOrder);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const setSelectedGroupId = useStore((s) => s.setSelectedGroupId);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const navigate = useStore((s) => s.navigate);

  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  const handleGroupClick = useCallback(
    (groupId: string) => {
      setSelectedGroupId(groupId);
      navigate("dashboard");
    },
    [setSelectedGroupId, navigate],
  );

  const handleCopyInviteLink = useCallback(async (groupId: string) => {
    try {
      await navigator.clipboard.writeText(
        `https://screenlink.app/invite/${groupId}`,
      );
      toast("Invite link copied");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = `https://screenlink.app/invite/${groupId}`;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast("Invite link copied");
    }
  }, []);

  const handleLeaveGroup = useCallback(() => {
    toast("Left group (local state only — full leave flow coming in a later stage)");
  }, []);

  const initials = (name: string) => {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  };

  return (
    <div className="flex flex-col items-center w-16 flex-shrink-0 bg-rail border-r border-border-subtle py-2 gap-1">
      {/* ─── Home/Product button ──────────────────────────── */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-lg text-text-secondary hover:text-text-primary"
            aria-label="Home"
            onClick={() => navigate("dashboard")}
          >
            <Home className="h-5 w-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Home</TooltipContent>
      </Tooltip>

      {/* ─── Groups list ──────────────────────────────────── */}
      <div className="flex-1 flex flex-col items-center gap-1 overflow-y-auto py-1 w-full px-2">
        <AnimatePresence mode="popLayout">
          {groupOrder.map((groupId, index) => {
            const group = groupsById[groupId];
            if (!group) return null;
            const isSelected = groupId === selectedGroupId;
            const hasActiveStreams =
              (activeStreamsByGroup[groupId]?.length ?? 0) > 0;

            return (
              <ContextMenu key={groupId}>
                <ContextMenuTrigger asChild>
                  <div className="relative">
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
                          // Single pulse then settle at 1.0 (Section 5.3)
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
                              {initials(group.name)}
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

                {/* Context menu on right-click */}
                <ContextMenuContent>
                  <ContextMenuItem
                    onClick={() => {
                      /* TODO 3.7C: rename group */
                    }}
                  >
                    Rename group
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => handleLeaveGroup()}
                  >
                    Leave group
                  </ContextMenuItem>
                  <ContextMenuSeparator />
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
      <DropdownMenu open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
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
              setCreateMenuOpen(false);
              /* TODO 3.7C: create group dialog */
            }}
          >
            Create group
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setCreateMenuOpen(false);
              /* TODO 3.7C: join group dialog */
            }}
          >
            Join group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
