import { useCallback, useEffect, useState } from "react";
import { Users, Radio, Monitor, RefreshCw, AlertTriangle } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useStore } from "@/stores/main-store";
import { getInitials } from "@/lib/utils";
import { fetchQualityPresets } from "@/services/group-actions";

// ─── Types ─────────────────────────────────────────────────────────────────

interface QualityPresetSummary {
  id: string;
  name: string;
  summary: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function memberCount(
  group: { members: Record<string, unknown> } | undefined,
): number {
  if (!group) return 0;
  return Object.keys(group.members).length;
}

// ─── Preset display helper ─────────────────────────────────────────────────

function presetSummary(
  preset: { id: string; name: string; settings: Record<string, unknown> },
): QualityPresetSummary {
  const s = preset.settings ?? {};
  const video = s.video as Record<string, unknown> | undefined;
  const w = (video?.sendWidth as number) ?? 854;
  const h = (video?.sendHeight as number) ?? 480;
  const f = (video?.sendFps as number) ?? 15;
  const b = (video?.videoBitrateKbps as number) ?? 650;
  return {
    id: preset.id,
    name: preset.name,
    summary: `${w}×${h} @ ${f} fps · ${b} kbps`,
  };
}

// ─── HomePage ───────────────────────────────────────────────────────────────

/**
 * HomePage — Landing / global aggregate view (Section 3.7G).
 *
 * Sections:
 *   1. Welcome header
 *   2. Group grid — real joined groups with name, member count,
 *      active-share count/live state, click-to-open-overview
 *   3. Personal presets — loaded from the real listQualityPresets API
 *      with loading/empty/error states and retry
 *   4. Create/Join group buttons → shared dialog state
 */
export function HomePage() {
  // ── Store bindings ─────────────────────────────────────────────────
  const groupsById = useStore((s) => s.groupsById);
  const groupOrder = useStore((s) => s.groupOrder);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const selectGroup = useStore((s) => s.selectGroup);
  const setOpenCreateGroupDialog = useStore((s) => s.setOpenCreateGroupDialog);
  const setOpenJoinGroupDialog = useStore((s) => s.setOpenJoinGroupDialog);

  const hasGroups = groupOrder.length > 0;

  // ── Presets state ──────────────────────────────────────────────────
  const [presets, setPresets] = useState<QualityPresetSummary[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetsError, setPresetsError] = useState<string | null>(null);

  const loadPresets = useCallback(async () => {
    setPresetsLoading(true);
    setPresetsError(null);
    try {
      const raw = (await fetchQualityPresets()) as Array<{
        id: string;
        name: string;
        settings: Record<string, unknown>;
      }>;
      setPresets(raw.map(presetSummary));
    } catch (err) {
      setPresetsError(
        err instanceof Error ? err.message : "Failed to load presets",
      );
    } finally {
      setPresetsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  // ── Handlers ───────────────────────────────────────────────────────

  const handleGroupClick = useCallback(
    (groupId: string) => {
      selectGroup(groupId);
    },
    [selectGroup],
  );

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      {/* ─── Header ───────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">
          ScreenLink
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Share your screen with anyone, anywhere.
        </p>
      </div>

      {/* ─── Section 1: Group grid ────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-text-primary">
            {hasGroups ? "Your groups" : "Groups"}
          </h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpenCreateGroupDialog(true)}
            >
              Create group
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpenJoinGroupDialog(true)}
            >
              Join group
            </Button>
          </div>
        </div>

        {!hasGroups ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex items-center justify-center h-12 w-12 rounded-dialog bg-surface-3">
                <Users className="h-6 w-6 text-text-muted" />
              </div>
              <p className="text-sm text-text-secondary max-w-xs">
                No groups yet. Create or join a group to start sharing your
                screen.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {groupOrder.map((gid) => {
              const group = groupsById[gid];
              if (!group) return null;
              const memberCount_ = memberCount(group);
              const activeShares =
                activeStreamsByGroup[gid]?.length ?? 0;

              return (
                <motion.div
                  key={gid}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Card
                    className="cursor-pointer transition-colors hover:bg-surface-hover"
                    onClick={() => handleGroupClick(gid)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleGroupClick(gid);
                      }
                    }}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        {/* Group icon */}
                        <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-surface-3 flex-shrink-0">
                          <span className="text-sm font-semibold text-text-primary">
                            {getInitials(group.name)}
                          </span>
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text-primary truncate">
                              {group.name}
                            </span>
                            {activeShares > 0 && (
                              <Badge
                                variant="success"
                                className="text-[10px] px-1.5 py-0 leading-none flex-shrink-0"
                              >
                                <Radio className="h-2.5 w-2.5 mr-0.5" />
                                Live
                              </Badge>
                            )}
                          </div>

                          <div className="flex items-center gap-3 mt-1">
                            <span className="text-xs text-text-muted flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {memberCount_}{" "}
                              {memberCount_ === 1 ? "member" : "members"}
                            </span>
                            {activeShares > 0 && (
                              <span className="text-xs text-text-muted flex items-center gap-1">
                                <Radio className="h-3 w-3" />
                                {activeShares}{" "}
                                {activeShares === 1 ? "share" : "shares"}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Section 2: Personal presets ──────────────────────────── */}
      <Separator />

      <section>
        <h2 className="text-sm font-medium text-text-primary mb-4">
          Personal presets
        </h2>

        {presetsLoading ? (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2 min-w-[180px]">
                <Skeleton className="h-24 w-full rounded-standard" />
              </div>
            ))}
          </div>
        ) : presetsError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Failed to load presets</AlertTitle>
            <AlertDescription>{presetsError}</AlertDescription>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={loadPresets}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Retry
            </Button>
          </Alert>
        ) : presets.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center">
              <p className="text-sm text-text-muted">
                No presets yet. Create quality presets to quickly apply
                your preferred streaming settings.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {presets.map((preset) => (
              <Card
                key={preset.id}
                className="min-w-[180px] flex-shrink-0"
              >
                <CardContent className="p-4">
                  <span className="block text-sm font-medium text-text-primary">
                    {preset.name}
                  </span>
                  <span className="block text-xs text-text-muted mt-1 font-mono tabular-nums">
                    {preset.summary}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
