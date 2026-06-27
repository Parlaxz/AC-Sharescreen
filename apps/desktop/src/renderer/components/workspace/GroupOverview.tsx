import { useCallback, useEffect, useMemo, useState } from "react";
import {
  UserPlus,
  Monitor,
  Eye,
  RefreshCw,
  AlertTriangle,
  Repeat,
  Check,
  X,
  Loader2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { getInitials } from "@/lib/utils";
import {
  useStore,
  type StreamAnnouncement,
  type Page,
} from "@/stores/main-store";
import { toast } from "sonner";
import { MembersList } from "./MembersList.js";
import { copyGroupInviteFromUi } from "@/services/invite-copy";
import { startShare } from "@/services/share-coordinator";
import {
  customPresetToOverride,
  presetSettingsToOverride,
  type SessionQualityOverride,
} from "@/services/share-quality";
import { fetchQualityPresets } from "@/services/group-actions";
import { getRuntime } from "@/services/phase3-runtime";
import type { CaptureSourceDTO } from "../../../preload/api-types.js";

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

// ─── Props ────────────────────────────────────────────────────────────────

interface GroupOverviewProps {
  groupId?: string;
  loading?: boolean;
  error?: string | null;
  degraded?: boolean;
  permissionBlocked?: boolean;
}

// ─── Active Share Card ────────────────────────────────────────────────────

interface ActiveShareCardProps {
  share: StreamAnnouncement;
}

function ActiveShareCard({ share }: ActiveShareCardProps) {
  const duration = useMemo(() => formatLiveDuration(share.startedAt), [share.startedAt]);
  const hostDeviceId = share.hostDeviceId;

  // Active shares in this group — used to determine whether a
  // member is the host of an active share.
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const groupsById = useStore((s) => s.groupsById);
  const isViewing = useStore((s) => s.isViewing);
  const setIsViewing = useStore((s) => s.setIsViewing);
  const setViewStatus = useStore((s) => s.setViewStatus);
  const setWatchedStreams = useStore((s) => s.setWatchedStreams);
  const navigate = useStore((s) => s.navigate);

  const memberIsSharing = useMemo(() => {
    const group = groupsById[share.groupId];
    if (!group) return false;
    const streams = activeStreamsByGroup[share.groupId] ?? [];
    return streams.some(
      (s) => s.hostDeviceId === hostDeviceId || s.logicalStreamId === share.logicalStreamId,
    );
  }, [activeStreamsByGroup, groupsById, share.groupId, share.logicalStreamId, hostDeviceId]);

  const handleWatch = useCallback(() => {
    if (isViewing) return;
    // Set explicit watching target — no first-entry heuristics
    const target = {
      groupId: share.groupId,
      logicalStreamId: share.logicalStreamId,
      mediaSessionId: share.mediaSessionId,
      hostDeviceId: share.hostDeviceId,
      hostName: share.hostDisplayName,
      startedAt: share.startedAt,
      sourceName: share.sourceName,
      sourceKind: share.sourceKind,
    };
    setWatchedStreams((prev) => ({
      ...prev,
      [share.mediaSessionId]: {
        hostDeviceId: share.hostDeviceId,
        hostName: share.hostDisplayName,
        startedAt: share.startedAt,
      },
    }));
    useStore.getState().setWatchingTarget(target);
    setIsViewing(true);
    setViewStatus("connecting");
    navigate("viewer");
  }, [isViewing, share, setWatchedStreams, setIsViewing, setViewStatus, navigate]);

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

              <span className="block text-[11px] text-text-muted mt-1">
                {duration}
              </span>
            </div>
          </div>

          <Separator className="my-3" />

          {/* Footer row — real Watch button for remote streams */}
          <div className="flex items-center justify-end gap-2">
            {memberIsSharing && (
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0"
                aria-label="Member is the active host"
              >
                Sharing
              </Badge>
            )}
            <Button
              variant="default"
              size="sm"
              className="h-7 text-xs px-3"
              onClick={handleWatch}
              disabled={isViewing}
              aria-label={`Watch ${share.hostDisplayName}'s stream`}
            >
              <Eye className="h-3 w-3 mr-1" />
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
 * Horizontally centered (mx-auto, max-w-5xl) layout with a group
 * heading + actions, an Active shares section, and a Members
 * section. The Members section is always rendered (whether or not
 * there are active shares) and uses real group member data.
 *
 * Active share cards include a real Watch button that triggers the
 * viewer join flow via ViewerSession. No simulation or timers.
 *
 * Composed from Watermelon: Card, Avatar, Badge, Button, Tooltip,
 * Skeleton, Alert, Separator + framer-motion. No fake stream
 * statistics, no fake stream actions.
 */
export function GroupOverview({
  groupId: overrideGroupId,
  loading = false,
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

  const memberCount = group ? Object.keys(group.members).length : 0;

  const setIsSharing = useStore((s) => s.setIsSharing);

  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);

  // ── "Share again" / reuse-last-settings state ────────────────────────
  const [showShareAgainConfirm, setShowShareAgainConfirm] = useState(false);
  const [shareAgainPending, setShareAgainPending] = useState(false);
  const [lastShareSettings, setLastShareSettings] = useState<{
    groupId: string;
    sourceKind: "screen" | "window";
    sourceId: string;
    sourceName: string;
    audioMode: "none" | "monitor" | "application";
    selectedPresetId: string | null;
    customQuality: {
      resolutionValue: string;
      customWidth: number;
      customHeight: number;
      fps: number;
      bitrate: number;
      codec: string;
      contentHint: string;
      degradationPreference: string;
    };
  } | null>(null);

  // Load last share settings on mount
  useEffect(() => {
    const api = (window as unknown as { screenlink?: { getSettings: () => Promise<Record<string, unknown>> } }).screenlink;
    if (!api) return;
    void api.getSettings().then((settings) => {
      const last = settings.lastShareSettings as typeof lastShareSettings;
      if (last?.sourceName) {
        setLastShareSettings(last);
      }
    }).catch(() => {});
  }, []);

  const handleStartSharing = useCallback(() => {
    setIsSharing(false);
    setOpenShareSetup(true);
  }, [setOpenShareSetup, setIsSharing]);

  const handleShareAgain = useCallback(() => {
    setShowShareAgainConfirm(true);
  }, []);

  // ── One-click "Share again": verify source, then start or fallback ──
  const handleConfirmShareAgain = useCallback(async () => {
    setShowShareAgainConfirm(false);
    const settings = lastShareSettings;
    if (!settings) return;

    setShareAgainPending(true);

    try {
      // 1) Fetch current sources to check availability
      const api = (window as unknown as { screenlink?: { getSources: () => Promise<CaptureSourceDTO[]> } }).screenlink;
      let sourceAvailable = false;
      let matchingSource: CaptureSourceDTO | null = null;

      if (api) {
        const sources = await api.getSources();
        matchingSource = sources.find((s) => s.id === settings.sourceId) ?? null;
        sourceAvailable = matchingSource !== null;
      }

      if (!sourceAvailable || !matchingSource) {
        // Fall back to opening ShareSetup with restored settings + notify
        toast.info("Last source unavailable — opening setup with restored settings");
        setIsSharing(false);
        setOpenShareSetup(true);
        return;
      }

      // 2) Load personal quality presets to resolve preset->override
      const presets = await fetchQualityPresets().catch(() => []);
      const presetList = presets.map((p: any) => ({ id: p.id, name: p.name, settings: p.settings }));

      // 3) Resolve quality override
      const groupId = settings.groupId || useStore.getState().selectedGroupId;
      if (!groupId) {
        toast.error("No group selected for sharing");
        return;
      }

      const qualityOverride = (() => {
        if (settings.selectedPresetId) {
          const preset = presetList.find((p: any) => p.id === settings.selectedPresetId);
          if (preset) {
            return presetSettingsToOverride(
              (preset.settings as { video?: Record<string, unknown> } | undefined),
            );
          }
        }
        if (settings.customQuality) {
          return customPresetToOverride({
            width: settings.customQuality.customWidth,
            height: settings.customQuality.customHeight,
            fps: settings.customQuality.fps,
            bitrate: settings.customQuality.bitrate,
            codec: settings.customQuality.codec,
            contentHint: settings.customQuality.contentHint,
            degradationPreference: settings.customQuality.degradationPreference,
          });
        }
        return null;
      })();

      // 4) Start sharing directly
      await startShare({
        groupId,
        source: {
          id: matchingSource.id,
          name: matchingSource.name,
          kind: matchingSource.kind,
          displayId: matchingSource.displayId ?? null,
          fingerprint: null,
          audioMode: settings.audioMode === "none" ? "none" : settings.audioMode,
        },
        qualityOverride: qualityOverride ?? undefined,
      });

      toast.success("Sharing started with last settings");
      setIsSharing(false);
      navigate("host" as Page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Share again failed: ${msg}`);
      // Fallback: open ShareSetup
      setIsSharing(false);
      setOpenShareSetup(true);
    } finally {
      setShareAgainPending(false);
    }
  }, [lastShareSettings, setOpenShareSetup, setIsSharing, navigate]);

  const handleCancelShareAgain = useCallback(() => {
    setShowShareAgainConfirm(false);
  }, []);

  // ── Manual refresh ────────────────────────────────────────────
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!groupId || refreshing) return;
    setRefreshing(true);
    try {
      const runtime = getRuntime();
      if (runtime) {
        await runtime.requestGroupSync(groupId);
      }
    } catch {
      // Silently ignore — refresh is best-effort
    } finally {
      setRefreshing(false);
    }
  }, [groupId, refreshing]);

  const handleInvite = useCallback(async () => {
    if (!groupId) return;
    await copyGroupInviteFromUi(groupId, "Invite link copied");
  }, [groupId]);

  // ── Loading state ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="mx-auto max-w-5xl p-6" role="status" aria-label="Loading overview">
        <div className="mb-6">
          <Skeleton className="h-6 w-40 mb-2" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-standard" />
          ))}
        </div>
      </div>
    );
  }

  // ── Degraded state ───────────────────────────────────────────────
  if (degraded) {
    return (
      <div className="mx-auto max-w-5xl p-6">
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
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────
  if (error) {
    return (
      <div className="mx-auto max-w-5xl p-6">
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
      <div className="mx-auto max-w-5xl p-6">
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
      <div className="mx-auto max-w-5xl p-6">
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
  return (
    <div className="mx-auto max-w-5xl p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
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

          {lastShareSettings && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleShareAgain}
                  aria-label="Share again with last settings"
                >
                  <Repeat className="h-3.5 w-3.5" />
                  Share again
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Reuse last source ({lastShareSettings.sourceName})
              </TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing}
                aria-label="Refresh group state"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5${refreshing ? " animate-spin" : ""}`}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Refresh group state
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

        {/* ─── Share again confirmation dialog ─────────────────── */}
        <Dialog open={showShareAgainConfirm} onOpenChange={setShowShareAgainConfirm}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Share again?</DialogTitle>
              <DialogDescription>
                {lastShareSettings ? (
                  <>
                    Reuse your last share settings:
                    <br />
                    <span className="font-medium">{lastShareSettings.sourceName}</span>
                    {" · "}
                    <span className="capitalize">{lastShareSettings.sourceKind}</span>
                    {lastShareSettings.audioMode !== "none" && (
                      <> · Audio: <span className="capitalize">{lastShareSettings.audioMode}</span></>
                    )}
                  </>
                ) : (
                  "Open share setup with last used settings."
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={handleCancelShareAgain} disabled={shareAgainPending}>
                <X className="h-3.5 w-3.5 mr-1" />
                Cancel
              </Button>
              <Button variant="default" size="sm" onClick={handleConfirmShareAgain} disabled={shareAgainPending}>
                {shareAgainPending ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />Starting...</>
                ) : (
                  <><Check className="h-3.5 w-3.5 mr-1" />Continue</>
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* ─── Active shares section (always rendered) ─────────── */}
      <section>
        <h2 className="text-sm font-medium text-text-primary mb-3">
          Active shares
        </h2>
        {activeShares.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-sm text-text-muted">
              No active shares in {group.name}.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {activeShares.map((share) => (
                <ActiveShareCard
                  key={share.logicalStreamId}
                  share={share}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      {/* ─── Members section (always rendered) ──────────────────── */}
      <section>
        <h2 className="text-sm font-medium text-text-primary mb-3">Members</h2>
        <MembersList groupId={groupId ?? undefined} />
      </section>
    </div>
  );
}
