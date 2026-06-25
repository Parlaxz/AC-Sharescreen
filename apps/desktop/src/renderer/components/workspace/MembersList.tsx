import { User } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useStore } from "@/stores/main-store";
import { getInitials } from "@/lib/utils";

/**
 * MembersList — renders the real members of the selected group
 * (Section 15).
 *
 * The list is rendered in two states:
 *   - Empty (no members): "You're the only member here."
 *   - Populated: avatar + display name + (optional) Sharing badge
 *     when the member is the host of an active share.
 *
 * There is no overflow menu, no "View profile", no "Remove member",
 * and no fake "Last seen recently" or role/tooltip text. Members
 * are the real records stored in the group.
 */

interface MembersListProps {
  /** Override the selected group — defaults to useStore.selectedGroupId */
  groupId?: string;
  loading?: boolean;
  error?: string | null;
}

export function MembersList({
  groupId: overrideGroupId,
  loading = false,
  error = null,
}: MembersListProps) {
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);

  const groupId = overrideGroupId ?? selectedGroupId;
  const group = groupId ? groupsById[groupId] : null;
  const members = group ? Object.entries(group.members) : [];
  const activeShares = groupId
    ? (activeStreamsByGroup[groupId] ?? [])
    : [];
  const activeHostDeviceIds = new Set(
    activeShares.map((s) => s.hostDeviceId).filter(Boolean) as string[],
  );

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

  return (
    <ScrollArea className="max-h-[400px]">
      <div className="space-y-1 pr-2">
        <AnimatePresence mode="popLayout">
          {members.map(([deviceId, member]) => {
            const isSharing = activeHostDeviceIds.has(deviceId);
            return (
              <motion.div
                key={deviceId}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex items-center gap-2.5 px-3 py-2 rounded-standard hover:bg-surface-hover transition-colors"
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
                </div>

                {isSharing && (
                  <Badge
                    variant="success"
                    className="text-[10px] px-1.5 py-0"
                    aria-label={`${member.displayName} is sharing`}
                  >
                    Sharing
                  </Badge>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ScrollArea>
  );
}
