import { Users, Radio } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useStore } from "@/stores/main-store";

/**
 * ContextPanel — Optional right-side contextual panel (Section 9).
 *
 * Only rendered when the user is actively hosting (isSharing === true).
 * Tabs are only shown when backed by real data:
 *  - "Viewers" tab shows live viewer count
 *  - "Streams" tab shows active streams for the selected group
 *
 * No placeholder tabs or fake content. When there is no real data to
 * display, the panel content area shows a minimal empty state instead of
 * fabricated placeholder rows.
 */
export function ContextPanel() {
  const showContextPanel = useStore((s) => s.showContextPanel);
  const toggleContextPanel = useStore((s) => s.toggleContextPanel);
  const viewerCount = useStore((s) => s.viewerCount);
  const isSharing = useStore((s) => s.isSharing);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);

  const activeStreams = selectedGroupId
    ? (activeStreamsByGroup[selectedGroupId] ?? [])
    : [];

  // Only render panels with real data
  const hasViewers = isSharing && viewerCount > 0;
  const hasStreams = activeStreams.length > 0;

  const hasAnyData = hasViewers || hasStreams;

  return (
    <AnimatePresence>
      {showContextPanel && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 300, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeInOut" }}
          className="flex flex-col flex-shrink-0 bg-surface-1 border-l border-border-subtle overflow-hidden"
        >
          {/* ─── Header ──────────────────────────────────────── */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-subtle">
            <span className="text-sm font-semibold text-text-primary">Context</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Close context panel"
                  onClick={toggleContextPanel}
                >
                  <Radio className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close panel</TooltipContent>
            </Tooltip>
          </div>

          {/* ─── Content ─────────────────────────────────────── */}
          <div className="flex-1">
            <ScrollArea className="h-full">
              <div className="p-3 space-y-4">
                {/* Viewers section (only when hosting with viewers) */}
                {hasViewers && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Users className="h-3.5 w-3.5 text-text-muted" />
                      <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                        Viewers
                      </span>
                      <Badge variant="default" className="text-[10px] px-1.5 py-0 ml-auto">
                        {viewerCount}
                      </Badge>
                    </div>
                    <p className="text-xs text-text-secondary">
                      {viewerCount} {viewerCount === 1 ? "viewer is" : "viewers are"} connected.
                    </p>
                  </div>
                )}

                {/* Active streams section */}
                {hasStreams && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Radio className="h-3.5 w-3.5 text-text-muted" />
                      <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                        Active streams
                      </span>
                      <Badge variant="default" className="text-[10px] px-1.5 py-0 ml-auto">
                        {activeStreams.length}
                      </Badge>
                    </div>
                    <div className="space-y-1.5">
                      {activeStreams.map((s) => (
                        <div
                          key={s.logicalStreamId}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-compact bg-surface-2"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="block text-xs text-text-primary truncate">
                              {s.hostDisplayName}
                            </span>
                            <span className="block text-[10px] text-text-muted truncate">
                              {s.sourceName}
                            </span>
                          </div>
                          <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Empty state when no real data */}
                {!hasAnyData && (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <Radio className="h-6 w-6 text-text-muted" />
                    <p className="text-xs text-text-muted">
                      Context information will appear here when hosting a stream.
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
