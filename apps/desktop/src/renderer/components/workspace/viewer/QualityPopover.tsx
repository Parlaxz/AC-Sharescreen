import { useState, type ReactNode } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

export type QualityLevel = "custom";

interface QualityPopoverProps {
  current?: QualityLevel;
  onSelect: (level: QualityLevel) => void;
  children: ReactNode;
}

/**
 * The viewer quality control is hidden by default by the parent
 * because there is no real request UI wired in this pass. This
 * component remains as a minimal, truthful fallback when explicitly
 * enabled in the future.
 */
export function QualityPopover({ current, onSelect, children }: QualityPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-64 p-3 space-y-3">
        <div>
          <p className="text-sm font-medium text-text-primary">Viewer quality</p>
          <p className="text-xs text-text-muted mt-1">
            Viewer quality requests are unavailable in this build.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            onSelect(current ?? "custom");
            setOpen(false);
          }}
        >
          Close
        </Button>
      </PopoverContent>
    </Popover>
  );
}
