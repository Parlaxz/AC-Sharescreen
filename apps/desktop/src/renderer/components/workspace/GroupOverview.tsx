import { useCallback, useMemo, useState } from "react";
import {
  Play,
  UserPlus,
  Monitor,
  Volume2,
  Eye,
  EllipsisVertical,
  ArrowUpFromLine,
  ArrowDownToLine,
  Ear,
  Ban,
  RefreshCw,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
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
import { Separator } from "@/components/ui/separator";
import {
  useStore,
  type StreamAnnouncement,
} from "@/stores/main-store";
import { InviteDialog } from "./InviteDialog.js";

// ─── Duration formatting ─────────────────────────────────────────────────

function formatLiveDuration(startedAt: number): string {
  const elapsed = Date.now() - startedAt;
  if (elapsed < 0) return "Live";
  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ─── Initials helper ────────────────────────────────────────────────────

// ─── Props ────────────────────────────────────────────────────────────────

interface GroupOverviewProps {
  /** Override the selected group — defaults to useStore.selectedGroupId */
  groupId?: string;
  /** Simulate loading state for demos/testing */
  loading?: boolean;
  /** Simulate connecting state */
  connecting?: boolean;
  /** Simulate error state */
  error?: string | null;
  /** Simulate degraded state */
  degraded?: boolean;
  /** Simulate permission blocked */
  permissionBlocked?: boolean;
}

// ─── Active Share Card ────────────────────────────────────────────────────

interface ActiveShareCardProps {
  share: StreamAnnouncement;
  onWatch: (share: StreamAnnouncement) => void;
}

function ActiveShareCard({ share, onWatch }: ActiveShareCardProps) {
  const duration = useMemo(() => formatLiveDuration(share.startedAt), [share.startedAt]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ type: "spring", stiffness: 350, damping: 28 }}
    >
      <Card className="group">
        <CardContent className="p-4">
          {/* Top row: avatar + name + source + duration */}
          <div className="flex items-start gap-3">
            <Avatar className="h-10 w-10 rounded-lg flex-shrink-0">
              <AvatarFallback className="rounded-lg bg-surface-3 text-xs font-semibold">
                {getInitials(share.hostDisplayName)}
              </AvatarFallback>
            </Avatar>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary truncate">
                  {share.hostDisplayName}
                </span>
                <Badge
                  variant="success"
                  className="text-[10px] px-1.5 py-0 leading-none"
                >
                  Live
                </Badge>
              </div>

              <div className="flex items-center gap-1.5 mt-0.5">
                <Monitor className="h-3 w-3 text-text-muted flex-shrink-0" />
                <span className="text-xs text-text-secondary truncate">
                  {share.sourceName || share.sourceKind || "Unknown source"}
                </span>
              </div>

              {/* Live duration */}
              <span className="block text-[11px] text-text-muted mt-1">
                {duration}
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
                      className="h-7 w-7 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label="Stream actions"
                    >
                      <EllipsisVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">Stream actions</TooltipContent>
              </Tooltip>

              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem
                  onClick={() => {
                    toast("Requested higher quality");
                  }}
                >
                  <ArrowUpFromLine className="h-4 w-4" />
                  Request higher quality
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    toast("Requested lower quality");
                  }}
                >
                  <ArrowDownToLine className="h-4 w-4" />
                  Request lower quality
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    toast("Audio muted for you");
                  }}
                >
                  <Ear className="h-4 w-4" />
                  Mute audio for me
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    toast("Stream stopped for you");
                  }}
                >
                  <Ban className="h-4 w-4" />
                  Stop sending to me
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Divider */}
          <Separator className="my-3" />

          {/* Bottom row: stream details + audio + viewers + watch */}
          <div className="flex items-center justify-between gap-4">
            {/* Technical details — monospace + tabular figures (Section 3.2) */}
            <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-text-muted cursor-default">
                    {share.sourceKind === "screen" ? "1920×1080" : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">Resolution</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-text-muted cursor-default">—</span>
                </TooltipTrigger>
                <TooltipContent side="top">Frame rate</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-text-muted cursor-default">—</span>
                </TooltipTrigger>
                <TooltipContent side="top">Bitrate</TooltipContent>
              </Tooltip>
            </div>

            {/* Audio mode indicator */}
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 text-[11px] text-text-muted cursor-default">
                    <Volume2 className="h-3 w-3" />
                    <span>Audio</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">Audio enabled</TooltipContent>
              </Tooltip>
            </div>

            {/* Viewer count */}
            <div className="flex items-center gap-1">
              <Eye className="h-3 w-3 text-text-muted" />
              <span className="text-[11px] text-text-muted tabular-nums font-mono">
                —
              </span>
            </div>

            {/* Watch button */}
            <Button
              variant="default"
              size="sm"
              className="flex-shrink-0"
              onClick={() => onWatch(share)}
            >
              <Play className="h-3.5 w-3.5" />
              Watch
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── GroupOverview ────────────────────────────────────────────────────────

/**
 * GroupOverview — Primary workspace content for the dashboard page (Section 8).
 *
 * Two main states driven by `activeStreamsByGroup[selectedGroupId]`:
 *   1. No active shares (Section 8.1): empty state with Start sharing action
 *   2. Active shares (Section 8.2): share cards with stream details
 *
 * Additional states (Section 15):
 *   Loading    → Skeleton cards
 *   Connecting → Progress + status
 *   Degraded   → Amber Alert
 *   Error      → Destructive Alert with retry
 *   Permission → Alert with recovery action
 *
 * Composed from Watermelon: Card, Avatar, Badge, Button, DropdownMenu,
 * Tooltip, Skeleton, Alert, Progress, Separator + framer-motion
 * AnimatePresence/layout for card insertion/removal.
 */
export function GroupOverview({
  groupId: overrideGroupId,
  loading = false,
  connecting = false,
  error = null,
  degraded = false,
  permissionBlocked = false,
}: GroupOverviewProps) {
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const navigate = useStore((s) => s.navigate);

  const groupId = overrideGroupId ?? selectedGroupId;
  const group = groupId ? groupsById[groupId] : null;
  const activeShares = groupId
    ? (activeStreamsByGroup[groupId] ?? [])
    : [];

  // Invite dialog state
  const [inviteOpen, setInviteOpen] = useState(false);

  const memberCount = group ? Object.keys(group.members).length : 0;

  const setIsViewing = useStore((s) => s.setIsViewing);
  const setViewStatus = useStore((s) => s.setViewStatus);

  const handleWatch = useCallback(
    (share: StreamAnnouncement) => {
      setIsViewing(true);
      setViewStatus("connecting");
      toast(`Joining ${share.hostDisplayName}'s stream...`);
      // In a real implementation, this would establish the WebRTC
      // subscriber connection. For now, simulate connected state.
      setTimeout(() => {
        setViewStatus("connected");
      }, 1500);
    },
    [setIsViewing, setViewStatus],
  );

  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);

  const handleStartSharing = useCallback(() => {
    setOpenShareSetup(true);
  }, [setOpenShareSetup]);

  const handleInvite = useCallback(async () => {
    if (!groupId) return;
    try {
      await navigator.clipboard.writeText(
        `https://screenlink.app/invite/${groupId}`,
      );
      toast("Invite link copied");
    } catch {
      setInviteOpen(true);
    }
  }, [groupId]);

  // ── Loading state ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-6 max-w-2xl" role="status" aria-label="Loading overview">
        {/* Header skeleton */}
        <div className="mb-6">
          <Skeleton className="h-6 w-40 mb-2" />
          <Skeleton className="h-4 w-24" />
        </div>
        {/* Card skeletons */}
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-standard" />
          ))}
        </div>
      </div>
    );
  }

  // ── Connecting state ──────────────────────────────────────────────
  if (connecting) {
    return (
      <div className="p-6 max-w-2xl">
        <Alert variant="default">
          <AlertTitle>Connecting to group</AlertTitle>
          <AlertDescription>
            Establishing connection with group relay...
          </AlertDescription>
          <Progress value={45} className="mt-3 h-1.5" />
        </Alert>
      </div>
    );
  }

  // ── Degraded state ───────────────────────────────────────────────
  if (degraded) {
    return (
      <div className="p-6 max-w-2xl">
        <Alert variant="warning">
          <AlertTitle>Connection degraded</AlertTitle>
          <AlertDescription>
            Your connection to this group is experiencing issues. Some
            features may be slow or unavailable.
          </AlertDescription>
          <div className="mt-2 flex gap-2">
            <Button variant="outline" size="sm">
              <RefreshCw className="h-3.5 w-3.5" />
              Reconnect
            </Button>
          </div>
        </Alert>
        {/* Still show content below the alert */}
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────
  if (error) {
    return (
      <div className="p-6 max-w-2xl">
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("diagnostics")}
            >
              View diagnostics
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  // ── Permission blocked state ─────────────────────────────────────
  if (permissionBlocked) {
    return (
      <div className="p-6 max-w-2xl">
        <Alert variant="destructive">
          <AlertTitle>Screen sharing blocked</AlertTitle>
          <AlertDescription>
            Screen capture is blocked by your system. Please check your
            privacy and security settings to allow screen recording for
            ScreenLink.
          </AlertDescription>
          <div className="mt-2">
            <Button variant="default" size="sm">
              Open system settings
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  // ── No group selected ────────────────────────────────────────────
  if (!group) {
    return (
      <div className="p-6 max-w-2xl">
        <Card className="p-6">
          <div className="flex flex-col items-center text-center gap-3">
            <p className="text-sm text-text-secondary">
              Select a group from the rail to get started.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  // ── Active shares view ───────────────────────────────────────────
  if (activeShares.length > 0) {
    return (
      <div className="p-6 max-w-2xl">
        {/* Header (Section 8.1) */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">
              {group.name}
            </h1>
            <p className="text-xs text-text-muted mt-0.5">
              {memberCount} {memberCount === 1 ? "member" : "members"}
              {" · "}
              <span className="text-accent">
                {activeShares.length} active{" "}
                {activeShares.length === 1 ? "share" : "shares"}
              </span>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleInvite}
                  aria-label="Copy invite link"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Invite
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Copy invite link
              </TooltipContent>
            </Tooltip>

            <Button
              variant="default"
              size="sm"
              onClick={handleStartSharing}
            >
              <Monitor className="h-3.5 w-3.5" />
              Start sharing
            </Button>
          </div>
        </div>

        {/* Active share cards (Section 8.2) */}
        <div className="space-y-3">
          <AnimatePresence mode="popLayout">
            {activeShares.map((share) => (
              <ActiveShareCard
                key={share.logicalStreamId}
                share={share}
                onWatch={handleWatch}
              />
            ))}
          </AnimatePresence>
        </div>

        {/* Invite dialog */}
        {groupId && (
          <InviteDialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            groupName={group.name}
            groupId={groupId}
          />
        )}
      </div>
    );
  }

  // ── Empty state: no active shares (Section 8.1) ──────────────────
  return (
    <div className="p-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            {group.name}
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            {memberCount} {memberCount === 1 ? "member" : "members"}
          </p>
        </div>
      </div>

      {/* Concise empty state — left-aligned, not centered */}
      <Card className="p-6">
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-medium text-text-primary">
              No active shares in {group.name}
            </h2>
            <p className="text-sm text-text-secondary mt-1.5 leading-relaxed">
              Share your screen, a window, or an application to get started.
              Other members will be able to watch and follow along in real
              time.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="default"
              onClick={handleStartSharing}
            >
              <Monitor className="h-4 w-4" />
              Start sharing
            </Button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={handleInvite}
                >
                  <UserPlus className="h-4 w-4" />
                  Send invite link
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Copy invite link to clipboard
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </Card>

      {/* Invite dialog */}
      {groupId && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          groupName={group.name}
          groupId={groupId}
        />
      )}
    </div>
  );
}
