import { useState, useCallback, type ReactNode } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Check } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ─── Quality options ──────────────────────────────────────────────────────

export type QualityLevel = "data-saver" | "balanced" | "clear" | "custom";

interface QualityOption {
  id: QualityLevel;
  label: string;
  description: string;
  /** Encoding height in px (for the custom slider range) */
  maxHeight?: number;
  /** Encoding bitrate in kbps */
  bitrateKbps?: number;
}

const QUALITY_OPTIONS: QualityOption[] = [
  {
    id: "data-saver",
    label: "Data saver",
    description: "540p · ~1.5 Mbps",
    maxHeight: 540,
    bitrateKbps: 1500,
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "720p · ~4 Mbps",
    maxHeight: 720,
    bitrateKbps: 4000,
  },
  {
    id: "clear",
    label: "Clear",
    description: "1080p · ~8 Mbps",
    maxHeight: 1080,
    bitrateKbps: 8000,
  },
  {
    id: "custom",
    label: "Custom",
    description: "Adjust resolution and bitrate",
  },
];

// ─── Spring transition for selected row ────────────────────────────────────

const indicatorSpring = {
  type: "spring" as const,
  stiffness: 400,
  damping: 30,
};

// ─── Props ─────────────────────────────────────────────────────────────────

interface QualityPopoverProps {
  /** Currently active quality level */
  current?: QualityLevel;
  /** Called when a quality option is selected */
  onSelect: (level: QualityLevel) => void;
  /** Extra UI to append (the trigger button children) */
  children: ReactNode;
}

// ─── Component ─────────────────────────────────────────────────────────────

/**
 * QualityPopover — Quality selector for the viewer (Section 8.5).
 *
 * Composed from Watermelon: Popover, Button, Slider, Separator + framer-motion
 * animated selection indicator.
 *
 * Selecting a quality sends a `quality.request` signal to the host. For now,
 * fires a Sonner toast "Quality request sent".
 *
 * Custom quality reveals an inline Slider for resolution adjustment.
 */
export function QualityPopover({
  current,
  onSelect,
  children,
}: QualityPopoverProps) {
  const [open, setOpen] = useState(false);
  const [customBitrate, setCustomBitrate] = useState([4000]);

  const handleSelect = useCallback(
    (level: QualityLevel) => {
      onSelect(level);
      toast("Quality request sent");
      // In a real implementation, this would use the quality-client
      // to send a quality.request to the host via WebRTC data channel.
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="w-64 p-1.5"
      >
        {/* Quality options list */}
        <div className="space-y-0.5" role="radiogroup" aria-label="Video quality">
          {QUALITY_OPTIONS.map((option) => {
            const selected = current === option.id;
            return (
              <div key={option.id} className="relative">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={selected}
                  onClick={() => handleSelect(option.id)}
                  className={cn(
                    "relative flex w-full items-center gap-3 rounded-compact px-3 py-2.5 text-left transition-colors",
                    "hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
                    selected && "bg-accent-muted",
                  )}
                >
                  {/* Animated selection indicator */}
                  {selected && (
                    <motion.div
                      layoutId="quality-selected"
                      className="absolute inset-0 rounded-compact bg-accent-muted"
                      transition={indicatorSpring}
                    />
                  )}
                  <span className="relative flex-1">
                    <span className="block text-sm font-medium text-text-primary">
                      {option.label}
                    </span>
                    <span className="block text-xs text-text-muted mt-0.5">
                      {option.description}
                    </span>
                  </span>
                  {selected && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={indicatorSpring}
                      className="relative flex-shrink-0"
                    >
                      <Check className="h-4 w-4 text-accent" />
                    </motion.span>
                  )}
                </button>

                {/* Inline custom quality slider */}
                {option.id === "custom" && selected && (
                  <div className="px-3 pb-3 pt-1">
                    <Separator className="mb-3" />
                    <label
                      htmlFor="custom-bitrate"
                      className="block text-xs text-text-secondary mb-2"
                    >
                      Max bitrate: {customBitrate[0]} kbps
                    </label>
                    <Slider
                      id="custom-bitrate"
                      value={customBitrate}
                      onValueChange={setCustomBitrate}
                      min={500}
                      max={20000}
                      step={100}
                      aria-label="Custom bitrate"
                    />
                    <div className="flex justify-between mt-1">
                      <span className="text-[10px] text-text-muted">500</span>
                      <span className="text-[10px] text-text-muted">
                        20 000
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Quality info footer */}
        <div className="px-3 py-2 mt-1">
          <p className="text-[10px] text-text-muted leading-relaxed">
            Quality requests are sent to the stream host. The host may accept or
            reject based on their current settings and bandwidth.
          </p>
        </div>

        {/* Done button */}
        <div className="px-1 pb-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs"
            onClick={() => setOpen(false)}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
