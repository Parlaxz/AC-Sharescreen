import type React from "react";
import { motion, AnimatePresence } from "motion/react";
import { Separator } from "@/components/ui/separator";
import { ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { useStore } from "@/stores/main-store";
import { TitleBar } from "./TitleBar.js";
import { GroupRail } from "./GroupRail.js";
import { GroupDashboard } from "./GroupDashboard.js";
import { ContextPanel } from "./ContextPanel.js";
import { ViewerWorkspace } from "@/components/workspace/ViewerWorkspace.js";

// ─── Motion transitions ──────────────────────────────────────────────────

const columnCollapse = {
  type: "spring" as const,
  stiffness: 350,
  damping: 30,
  mass: 0.8,
};

const reducedCollapse = {
  duration: 0.15,
  ease: "easeInOut" as const,
};

/**
 * AppShell — ScreenLink layout foundation (Section 4).
 *
 * Composes the four visual regions from the design spec:
 *
 *   ┌───────────┬──────────────┬──────────────────────┬──────────────┐
 *   │ TITLE BAR │              │                      │              │
 *   ├───────────┤              │                      │              │
 *   │ GROUP     │ GROUP        │ PRIMARY WORKSPACE    │ CONTEXT      │
 *   │ RAIL      │ DASHBOARD    │                      │ PANEL        │
 *   │ 64px      │ 224–248px    │ fluid, min 560px     │ 280–320px    │
 *   │           ├──────────────┤                      │ (optional)   │
 *   │           │ USER DOCK    │                      │              │
 *   └───────────┴──────────────┴──────────────────────┴──────────────┘
 *
 * When `isViewing` is true AND `currentPage` is `"viewer"`:
 *   - ViewerWorkspace fills the primary workspace
 *   - GroupDashboard and ContextPanel are hidden
 *   - GroupRail remains visible
 * When `isViewing` is true AND `currentPage` is NOT `"viewer"`:
 *   - The routed page (home, settings, etc.) fills the workspace
 *   - GroupDashboard is shown, providing sidebar navigation and UserDock
 *   - ViewerWorkspace stays mounted in the background (WebRTC stays alive)
 *   - ContextPanel remains hidden
 * When `focusMode` is true (Section 5):
 *   - GroupRail, GroupDashboard, and ContextPanel are all hidden
 *   - Only the title bar and viewer workspace remain
 *
 * In fullscreen mode, the browser API hides everything including the title bar.
 */
interface AppShellProps {
  /** Primary workspace content (existing route pages) */
  children: React.ReactNode;
  /** Custom class for the shell wrapper */
  className?: string;
}

export function AppShell({ children, className }: AppShellProps) {
  const isViewing = useStore((s) => s.isViewing);
  const isSharing = useStore((s) => s.isSharing);
  const focusMode = useStore((s) => s.focusMode);
  const isContextPanelOpen = useStore((s) => s.showContextPanel);
  const currentPage = useStore((s) => s.currentPage);

  const showTitleBar = !focusMode;
  const showRail = !focusMode;
  // Show dashboard when:
  // 1. Not viewing (normal browsing), OR
  // 2. Viewing but on a non-viewer page (home, settings, etc.)
  // Always hide in focus mode.
  const showDashboard = (!isViewing || currentPage !== "viewer") && !focusMode;
  const isContextPanelEligible = !isViewing && !focusMode && isSharing;
  const showContextPanel = isContextPanelEligible && isContextPanelOpen;

  return (
    <div
      className={cn(
        "flex flex-col h-screen w-screen overflow-hidden bg-canvas text-text-primary font-sans",
        className,
      )}
    >
      {/* ─── Title Bar (Section 4.2) — hidden in focus/fullscreen mode ── */}
      <AnimatePresence>
        {showTitleBar ? (
          <motion.div
            key="title-bar"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 32, opacity: 1 }}
            exit={{ height: 0, opacity: 0, overflow: "hidden" }}
            transition={focusMode ? reducedCollapse : columnCollapse}
            className="flex-shrink-0"
          >
            <TitleBar />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ─── Main area — full-height content row ─────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ─── Group Rail (Section 5) ──────────────────────── */}
        <AnimatePresence>
          {showRail ? (
            <motion.div
              key="group-rail"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 64, opacity: 1 }}
              exit={{ width: 0, opacity: 0, overflow: "hidden" }}
              transition={focusMode ? reducedCollapse : columnCollapse}
              className="h-full min-h-0 flex-shrink-0 overflow-hidden"
            >
              <div className="w-16 h-full min-h-0">
                <GroupRail />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {showRail && <Separator orientation="vertical" />}

        {/* ─── Group Dashboard Column (Section 6 + 7) ────── */}
        <AnimatePresence>
          {showDashboard ? (
            <motion.div
              key="group-dashboard"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 236, opacity: 1 }}
              exit={{ width: 0, opacity: 0, overflow: "hidden" }}
              transition={columnCollapse}
              className="h-full min-h-0 flex-shrink-0 overflow-hidden"
            >
              <div className="w-[236px] h-full min-h-0">
                <GroupDashboard />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {showDashboard && <Separator orientation="vertical" />}

        {/* ─── Primary Workspace ─────────────────────────── */}
        <ResizablePanel className="flex-1 min-w-0 min-h-0 bg-canvas overflow-hidden relative">
          {isViewing && currentPage === "viewer" ? (
            <ViewerWorkspace />
          ) : (
            <main className="h-full min-h-0 overflow-auto">{children}</main>
          )}
          {/* When viewing a stream but on a non-viewer page (home, settings, etc.),
              keep ViewerWorkspace mounted in the background so the WebRTC session
              stays alive. Hidden via opacity/pointer-events, not display:none,
              so Chromium continues decoding video frames. */}
          {isViewing && currentPage !== "viewer" && (
            <div
              className="absolute inset-0 pointer-events-none opacity-0"
              aria-hidden="true"
            >
              <ViewerWorkspace />
            </div>
          )}
        </ResizablePanel>

        {/* ─── Context Panel (Section 9, optional) ───────── */}
        <AnimatePresence>
          {showContextPanel ? (
            <motion.div
              key="context-panel"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 300, opacity: 1 }}
              exit={{ width: 0, opacity: 0, overflow: "hidden" }}
              transition={columnCollapse}
              className="flex-shrink-0 overflow-hidden"
            >
              <div className="w-[300px]">
                <ContextPanel />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
