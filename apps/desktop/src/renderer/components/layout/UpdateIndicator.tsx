import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";

/**
 * UpdateIndicator — Small badge in the TitleBar showing update availability (Section 8).
 *
 * Click opens a Popover with version info and action buttons.
 * Animated slide-in from top when update becomes available.
 */
export function UpdateIndicator() {
  const [hasUpdate, setHasUpdate] = useState(true);
  const [version] = useState("1.1.0");
  const [whatsNew] = useState(
    "• Improved WebRTC connection stability\n• New system audio pipeline\n• Performance improvements for 4K streaming\n• Bug fixes and reliability enhancements",
  );

  const handleDownloadAndInstall = useCallback(() => {
    // In production: api.downloadUpdate()
    setHasUpdate(false);
  }, []);

  const handleLater = useCallback(() => {
    setHasUpdate(false);
  }, []);

  return (
    <AnimatePresence>
      {hasUpdate && (
        <motion.div
          key="update-indicator"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -20, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-accent hover:text-accent-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
                aria-label="Update available"
              >
                <Download className="h-3 w-3" />
                <span>Update</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-64">
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    Version {version} available
                  </p>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    A new version of ScreenLink is ready to download.
                  </p>
                </div>

                <Separator />

                <div>
                  <p className="text-[11px] font-medium text-text-secondary mb-1">
                    What's new
                  </p>
                  <pre className="text-[11px] text-text-muted leading-relaxed whitespace-pre-wrap font-sans">
                    {whatsNew}
                  </pre>
                </div>

                <div className="flex gap-2">
                  <Button size="sm" className="flex-1" onClick={handleDownloadAndInstall}>
                    Download &amp; install
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleLater}>
                    Later
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
