import { useCallback, useEffect, useState } from "react";
import { Minus, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { UpdateIndicator } from "@/components/layout/UpdateIndicator";
import type { ScreenLinkAPI } from "../../../preload/api-types.js";

/**
 * TitleBar — Compact custom Electron title bar (Section 4.2).
 *
 * Composed entirely from Watermelon primitives:
 *  - Button (icon size, ghost variant)
 *  - Tooltip (for every icon-only button)
 *
 * Layout (left to right):
 *   workspace/group name | drag region (flex-1) | minimize | maximize/restore | close
 *
 * Window controls use Electron IPC via the preload `windowControls` namespace.
 * If unavailable (dev mode), the buttons log a warning and do nothing.
 */
export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [workspaceName] = useState("ScreenLink");

  const api = (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink;

  const handleMinimize = useCallback(() => {
    if (api?.windowControls) {
      void api.windowControls.minimize();
    } else {
      console.warn("[TitleBar] windowControls API not available");
    }
  }, [api]);

  const handleToggleMaximize = useCallback(() => {
    if (api?.windowControls) {
      void api.windowControls.toggleMaximize().then((maximized) => {
        setIsMaximized(maximized);
      });
    } else {
      console.warn("[TitleBar] windowControls API not available");
    }
  }, [api]);

  const handleClose = useCallback(() => {
    if (api?.windowControls) {
      void api.windowControls.close();
    } else {
      console.warn("[TitleBar] windowControls API not available");
    }
  }, [api]);

  // Listen for fullscreen changes to sync maximize button state
  useEffect(() => {
    if (!api?.onFullscreenChanged) return;
    const unsub = api.onFullscreenChanged((isFullscreen) => {
      if (!isFullscreen) {
        setIsMaximized(false);
      }
    });
    return unsub;
  }, [api]);

  return (
    <div
      className={cn(
        "flex h-8 items-center flex-shrink-0 bg-rail border-b border-border-subtle select-none",
      )}
    >
      {/* ─── Workspace/Group name ─────────────────────────── */}
      <div className="flex items-center gap-2 px-3 min-w-0">
        <span className="text-xs font-semibold text-text-primary truncate">
          {workspaceName}
        </span>
      </div>

      {/* ─── Drag region ──────────────────────────────────── */}
      <div
        className="flex-1 h-full"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {/* ─── Update indicator (Section 8) ──────────────────── */}
      <UpdateIndicator />

      {/* ─── Window control buttons ───────────────────────── */}
      <div className="flex items-center h-full">
        {/* Minimize — 28×28 per spec */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-none hover:bg-surface-hover"
              aria-label="Minimize"
              onClick={handleMinimize}
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Minimize</TooltipContent>
        </Tooltip>

        {/* Maximize / Restore — 28×28 per spec */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-none hover:bg-surface-hover"
              aria-label={isMaximized ? "Restore" : "Maximize"}
              onClick={handleToggleMaximize}
            >
              {isMaximized ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isMaximized ? "Restore" : "Maximize"}
          </TooltipContent>
        </Tooltip>

        {/* Close — 28×28 per spec */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-none hover:bg-danger hover:text-white"
              aria-label="Close"
              onClick={handleClose}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
