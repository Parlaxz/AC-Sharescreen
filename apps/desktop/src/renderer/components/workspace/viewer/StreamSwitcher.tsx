import { useMemo, useCallback, type ReactNode } from "react";
import { Eye, Monitor } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useStore, type StreamAnnouncement } from "@/stores/main-store";
import { Button } from "@/components/ui/button";

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

interface StreamSwitcherProps {
  /** Currently selected logicalStreamId */
  currentStreamId: string;
  /** Called when a stream is selected */
  onSwitch: (stream: StreamAnnouncement) => void;
  /** The trigger button content */
  children: ReactNode;
}

/**
 * StreamSwitcher — Dropdown menu to switch between active streams (Section 8.5).
 *
 * Composed from Watermelon: DropdownMenu, Button, Tooltip + lucide icons.
 *
 * Lists all currently active shares from the store's `activeStreamsByGroup`.
 * Each row shows: sharer name, source label, viewer count, live duration.
 *
 * Disabled with Tooltip explanation when only one stream is live.
 */
export function StreamSwitcher({
  currentStreamId,
  onSwitch,
  children,
}: StreamSwitcherProps) {
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);

  const activeStreams = useMemo(() => {
    if (!selectedGroupId) return [];
    return activeStreamsByGroup[selectedGroupId] ?? [];
  }, [selectedGroupId, activeStreamsByGroup]);

  const onlyOneStream = activeStreams.length <= 1;

  const handleSelect = useCallback(
    (stream: StreamAnnouncement) => {
      if (stream.logicalStreamId === currentStreamId) return;
      onSwitch(stream);
    },
    [currentStreamId, onSwitch],
  );

  // ── Disabled state: only one stream ──────────────────────────────
  if (onlyOneStream) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          Only one stream is currently live
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="w-64">
        <DropdownMenuLabel>Switch stream</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {activeStreams.map((stream) => {
          const isCurrent = stream.logicalStreamId === currentStreamId;
          const duration = formatLiveDuration(stream.startedAt);
          return (
            <DropdownMenuItem
              key={stream.logicalStreamId}
              disabled={isCurrent}
              onSelect={() => handleSelect(stream)}
              className={isCurrent ? "bg-accent-muted" : undefined}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {/* Sharer info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {stream.hostDisplayName}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] text-accent font-medium flex-shrink-0">
                        Watching
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Monitor className="h-3 w-3 text-text-muted flex-shrink-0" />
                    <span className="text-xs text-text-secondary truncate">
                      {stream.sourceName || stream.sourceKind || "Unknown"}
                    </span>
                  </div>
                </div>

                {/* Metadata */}
                <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                  <span className="flex items-center gap-1 text-[11px] text-text-muted">
                    <Eye className="h-3 w-3" />
                    —
                  </span>
                  <span className="text-[11px] text-text-muted font-mono tabular-nums">
                    {duration}
                  </span>
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
