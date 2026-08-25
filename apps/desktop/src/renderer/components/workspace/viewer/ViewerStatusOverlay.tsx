import { motion } from "motion/react";
import {
  Monitor,
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";
import { cn } from "@/lib/utils";

// ─── Transitions ──────────────────────────────────────────────────────────

export const fadeSpring = {
  type: "spring" as const,
  stiffness: 300,
  damping: 26,
};

export const fadeInstant = {
  duration: 0.15,
  ease: "easeInOut" as const,
};

// ─── Props ────────────────────────────────────────────────────────────────

export interface ViewerStatusOverlayProps {
  /** The current viewer display status string (connecting / reconnecting / degraded / ended / error) */
  displayStatus: string;
  /** Display name of the stream sharer */
  sharerName: string;
  /** Error message from the session controller, shown in error state */
  viewerError: string | null;
  /** Formatted live duration string (e.g. "1h 23m"), shown in ended state */
  liveDuration: string;
  /** Callback for retry action (shown in error state) */
  onRetry: () => void;
  /** Callback for exit action (shown in ended and error states) */
  onExit: () => void;
  /** Whether the user prefers reduced motion */
  reduced: boolean;
  /** Optional class override */
  className?: string;
}

// ─── ViewerStatusOverlay ──────────────────────────────────────────────────

/**
 * ViewerStatusOverlay — Renders the appropriate status overlay or full-page
 * replacement based on the current display status.
 *
 * States:
 *   - ended    → Full-page animated exit message with auto-navigate hint
 *   - error    → Destructive Alert with retry/exit buttons
 *   - connecting → Skeleton + status text overlay
 *   - reconnecting → Amber Alert overlay with inline progress
 *   - degraded → Amber Alert overlay
 */
export function ViewerStatusOverlay({
  displayStatus,
  sharerName,
  viewerError,
  liveDuration,
  onRetry,
  onExit,
  reduced,
}: ViewerStatusOverlayProps) {
  switch (displayStatus) {
    case "ended":
      return (
        <motion.div
          key="ended"
          data-testid="viewer-ended-state"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? fadeInstant : { duration: 0.4 }}
          className="flex flex-col items-center justify-center h-full bg-canvas"
        >
          {/* Fading video element */}
          <motion.div
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={reduced ? { duration: 0.1 } : { duration: 0.6 }}
            className="absolute inset-0 bg-canvas"
          />

          {/* Ended message */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? fadeInstant : { delay: 0.3, duration: 0.4 }}
            className="relative z-10 flex flex-col items-center gap-4 text-center"
          >
            <div className="h-12 w-12 rounded-full bg-surface-3 flex items-center justify-center">
              <Monitor className="h-6 w-6 text-text-muted" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-text-primary">
                The streamer ended the share
              </h2>
              <p className="text-sm text-text-secondary mt-1">
                {sharerName}'s stream is no longer available.
                {liveDuration && ` It was live for ${liveDuration}.`}
              </p>
            </div>
            <Button variant="default" data-testid="viewer-exit-button" onClick={onExit}>
              <ArrowLeft className="h-4 w-4" />
              Return to overview
            </Button>
          </motion.div>
        </motion.div>
      );

    case "error":
      return (
        <motion.div
          key="error"
          data-testid="viewer-error-state"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? fadeInstant : fadeSpring}
          className="flex flex-col items-center justify-center h-full p-8"
        >
          <div className="max-w-md w-full">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Unable to play stream</AlertTitle>
              <AlertDescription>
                A fatal error occurred while trying to connect to or play
                {sharerName}'s stream. Please try again or check your
                connection.
                {viewerError && (
                  <span className="block mt-2 text-xs opacity-70" data-testid="viewer-error-message">
                    {viewerError}
                  </span>
                )}
              </AlertDescription>
            </Alert>
            <div className="flex items-center gap-3 mt-4 justify-center">
              <Button variant="default" data-testid="viewer-retry-button" onClick={onRetry}>
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
              <Button variant="ghost" data-testid="viewer-exit-button" onClick={onExit}>
                <ArrowLeft className="h-4 w-4" />
                Return to overview
              </Button>
            </div>
          </div>
        </motion.div>
      );

    case "connecting":
      return <ConnectingOverlay sharerName={sharerName} reduced={reduced} />;

    case "reconnecting":
      return <ReconnectingOverlay sharerName={sharerName} reduced={reduced} />;

    case "degraded":
      return <DegradedOverlay sharerName={sharerName} reduced={reduced} />;

    default:
      return null;
  }
}

// ─── Connecting overlay — skeleton + status text ──────────────────────────

/**
 * Connecting overlay — skeleton + status text shown during initial connection
 * and reconnection phases.
 */
function ConnectingOverlay({ sharerName, reduced }: { sharerName: string; reduced: boolean }) {
  return (
    <motion.div
      key="connecting-overlay"
      data-testid="viewer-status-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={reduced ? fadeInstant : fadeSpring}
      className="absolute inset-0 z-10 flex items-center justify-center bg-surface-2/80"
      role="status"
      aria-label="Connecting to stream"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="relative">
          <Skeleton className="h-16 w-16 rounded-full" />
          <span className="absolute inset-0 flex items-center justify-center">
            <Monitor className="h-7 w-7 text-text-muted" />
          </span>
        </div>
        <div className="text-center">
          <p className="text-sm text-text-secondary font-medium" data-testid="viewer-status-text">
            Connecting to {sharerName}'s stream
          </p>
          <p className="text-xs text-text-muted mt-1">
            Establishing secure relay connection...
          </p>
        </div>
        <Progress value={35} className="w-48 h-1" />
      </div>
    </motion.div>
  );
}

// ─── Reconnecting overlay — amber alert with inline progress bar ──────────

/** Reconnecting overlay — amber alert with inline progress bar. */
function ReconnectingOverlay({ sharerName, reduced }: { sharerName: string; reduced: boolean }) {
  return (
    <motion.div
      key="reconnecting-overlay"
      data-testid="viewer-status-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={reduced ? fadeInstant : fadeSpring}
      className="absolute top-4 left-4 right-4 z-20"
    >
      <Alert variant="warning" className="backdrop-blur-sm bg-surface-2/90">
        <div className="flex items-start gap-3">
          <WifiOff className="h-4 w-4 mt-0.5 text-warning" />
          <div className="flex-1">
            <AlertTitle>Reconnecting</AlertTitle>
            <AlertDescription>
              Attempting to restore the connection to {sharerName}'s stream.
            </AlertDescription>
            <Progress value={60} className="mt-3 h-1.5" />
          </div>
        </div>
      </Alert>
    </motion.div>
  );
}

// ─── Degraded overlay — amber alert for connection quality degradation ─────

/** Degraded overlay — amber alert for connection quality degradation. */
function DegradedOverlay({ sharerName, reduced }: { sharerName: string; reduced: boolean }) {
  return (
    <motion.div
      key="degraded-overlay"
      data-testid="viewer-status-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={reduced ? fadeInstant : fadeSpring}
      className="absolute top-4 left-4 right-4 z-20"
    >
      <Alert variant="warning" className="backdrop-blur-sm bg-surface-2/90">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-warning" />
          <div className="flex-1">
            <AlertTitle>Connection degraded</AlertTitle>
            <AlertDescription>
              The stream quality may be reduced. The host's connection is
              experiencing issues.
            </AlertDescription>
          </div>
        </div>
      </Alert>
    </motion.div>
  );
}
