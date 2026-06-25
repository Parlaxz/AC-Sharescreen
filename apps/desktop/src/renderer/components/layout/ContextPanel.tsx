import { useState } from "react";
import { X, Users, Radio, Info, Wifi, Activity } from "lucide-react";
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
 * Composed entirely from Watermelon primitives:
 *  - Button (close, tab triggers)
 *  - Badge (tab status indicators)
 *  - ScrollArea (scrollable content)
 *  - Tooltip (on icon buttons)
 *  - motion/AnimatePresence (panel entrance/exit)
 *
 * Tabs: Viewers / Members / Stream details / Connection / Activity
 * Each tab content is a placeholder.
 */
export function ContextPanel() {
  const showContextPanel = useStore((s) => s.showContextPanel);
  const toggleContextPanel = useStore((s) => s.toggleContextPanel);

  const [activeTab, setActiveTab] = useState<
    "viewers" | "members" | "stream-details" | "connection" | "activity"
  >("viewers");

  const tabs: {
    id: typeof activeTab;
    label: string;
    icon: React.ReactNode;
  }[] = [
    { id: "viewers", label: "Viewers", icon: <Users className="h-3.5 w-3.5" /> },
    { id: "members", label: "Members", icon: <Radio className="h-3.5 w-3.5" /> },
    { id: "stream-details", label: "Stream details", icon: <Info className="h-3.5 w-3.5" /> },
    { id: "connection", label: "Connection", icon: <Wifi className="h-3.5 w-3.5" /> },
    { id: "activity", label: "Activity", icon: <Activity className="h-3.5 w-3.5" /> },
  ];

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
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close panel</TooltipContent>
            </Tooltip>
          </div>

          {/* ─── Tabs (Section 9) ──────────────────────────── */}
          <div className="flex gap-1 px-2 py-2 border-b border-border-subtle overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-compact text-xs whitespace-nowrap transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  activeTab === tab.id
                    ? "bg-accent-muted text-accent font-medium"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* ─── Tab content (placeholder) ──────────────────── */}
          <div className="flex-1">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="h-full"
              >
                <ScrollArea className="h-full">
                  <div className="p-3 space-y-3">
                    {activeTab === "viewers" && (
                      <div className="text-sm text-text-secondary">
                        <p className="text-text-muted text-xs mb-2">
                          Active viewers will appear here.
                        </p>
                        <Badge variant="secondary" className="text-[10px]">
                          0 viewers
                        </Badge>
                      </div>
                    )}
                    {activeTab === "members" && (
                      <div className="text-sm text-text-secondary">
                        <p className="text-text-muted text-xs">
                          Group members will appear here.
                        </p>
                      </div>
                    )}
                    {activeTab === "stream-details" && (
                      <div className="text-sm text-text-secondary">
                        <p className="text-text-muted text-xs">
                          Stream details (resolution, bitrate, codec) will appear here.
                        </p>
                      </div>
                    )}
                    {activeTab === "connection" && (
                      <div className="text-sm text-text-secondary">
                        <p className="text-text-muted text-xs">
                          Connection statistics will appear here.
                        </p>
                      </div>
                    )}
                    {activeTab === "activity" && (
                      <div className="text-sm text-text-secondary">
                        <p className="text-text-muted text-xs">
                          Recent stream events will appear here.
                        </p>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
