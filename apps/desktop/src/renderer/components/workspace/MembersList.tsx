import {
  EllipsisVertical,
  UserPlus,
  User,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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
import { useStore } from "@/stores/main-store";
import { getInitials } from "@/lib/utils";

/**
 * MembersList — renders members of the selected group (Section 15).
 *
 * States (Section 15):
 *   Loading   → Skeleton rows
 *   Empty     → "You're the only member here. Invite friends to share with you."
 *   Error     → Alert with destructive variant + retry action
 *   Degraded  → Alert with warning variant
 *   Success   → Member rows with avatar + name + role badge + overflow menu
 *
 * Composed from Watermelon: Card, Avatar, Badge, DropdownMenu, ScrollArea,
 * Skeleton, Alert, Tooltip.
 */

interface MembersListProps {
  /** Override the selected group — defaults to useStore.selectedGroupId */
  groupId?: string;
  /** Simulate loading state for demos/testing */
  loading?: boolean;
  /** Simulate error state */
  error?: string | null;
}

export function MembersList({
  groupId: overrideGroupId,
  loading = false,
  error = null,
}: MembersListProps) {
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);

  const groupId = overrideGroupId ?? selectedGroupId;
  const group = groupId ? groupsById[groupId] : null;
  const members = group ? Object.entries(group.members) : [];

  // ── Loading state ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-1.5" role="status" aria-label="Loading members">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Failed to load members</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  // ── No group selected ────────────────────────────────────────────
  if (!group) {
    return (
      <Alert variant="default">
        <AlertTitle>No group selected</AlertTitle>
        <AlertDescription>
          Select a group from the rail to view its members.
        </AlertDescription>
      </Alert>
    );
  }

  // ── Empty state ──────────────────────────────────────────────────
  if (members.length === 0) {
    return (
      <Card className="p-6">
        <div className="flex flex-col items-center text-center gap-3">
          <div className="h-10 w-10 rounded-full bg-surface-3 flex items-center justify-center">
            <User className="h-5 w-5 text-text-muted" />
          </div>
          <p className="text-sm text-text-secondary">
            You're the only member here. Invite friends to share with you.
          </p>
        </div>
      </Card>
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────
  // ── Success: member rows ─────────────────────────────────────────
  return (
    <ScrollArea className="max-h-[400px]">
      <div className="space-y-1 pr-2">
        <AnimatePresence mode="popLayout">
          {members.map(([deviceId, member]) => (
            <motion.div
              key={deviceId}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className="flex items-center gap-2.5 px-3 py-2 rounded-standard hover:bg-surface-hover transition-colors group"
            >
              <Avatar className="h-8 w-8 flex-shrink-0">
                <AvatarFallback className="text-[11px] bg-surface-3">
                  {getInitials(member.displayName)}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <span className="block text-sm text-text-primary truncate font-medium">
                  {member.displayName}
                </span>
                <span className="block text-[11px] text-text-muted truncate">
                  Last seen recently
                </span>
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0"
                  >
                    Member
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Group member
                </TooltipContent>
              </Tooltip>

              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={`Menu for ${member.displayName}`}
                      >
                        <EllipsisVertical className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">Member actions</TooltipContent>
                </Tooltip>

                <DropdownMenuContent side="bottom" align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      /* TODO: view profile / details */
                    }}
                  >
                    <User className="h-4 w-4" />
                    View profile
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-danger"
                    onClick={() => {
                      /* TODO: remove member (owner only) */
                    }}
                  >
                    <UserPlus className="h-4 w-4" />
                    Remove member
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ScrollArea>
  );
}
