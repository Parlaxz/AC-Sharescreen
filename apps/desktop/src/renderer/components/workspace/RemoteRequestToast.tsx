import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Remote quality request types that a viewer can send to the host.
 */
export type RequestKind =
  | "higher-quality"
  | "lower-quality"
  | "specific-preset";

/**
 * A pending remote quality request from a viewer.
 */
export interface RemoteRequest {
  /** Unique request ID */
  id: string;
  /** Viewer's display name */
  viewerName: string;
  /** What the viewer is requesting */
  requestKind: RequestKind;
  /** When the request was received */
  receivedAt: number;
  /** Current status */
  status: "pending" | "accepted" | "rejected";
}

/**
 * Show a Watermelon sonner toast representing a remote quality request
 * from a viewer with two action buttons: Accept / Reject.
 *
 * Usage:
 *   notifyRemoteRequest("Alice", "higher-quality", (id) => accept(id), (id) => reject(id));
 *
 * Composed entirely from Watermelon sonner + Button primitives.
 */
export function notifyRemoteRequest(
  viewerName: string,
  requestKind: RequestKind,
  onAccept: () => void,
  onReject: () => void,
): string | number {
  const requestLabel = (() => {
    switch (requestKind) {
      case "higher-quality":
        return "higher quality";
      case "lower-quality":
        return "lower quality";
      case "specific-preset":
        return "a quality preset change";
    }
  })();

  const toastId = toast(
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-text-primary">
        Quality request
      </span>
      <span className="text-xs text-text-secondary">
        <strong className="text-text-primary">{viewerName}</strong> requested{" "}
        {requestLabel}
      </span>
      <div className="flex items-center gap-2 mt-1">
        <Button
          variant="default"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            onAccept();
            toast.dismiss(toastId);
          }}
        >
          Accept
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            onReject();
            toast.dismiss(toastId);
          }}
        >
          Reject
        </Button>
      </div>
    </div>,
    {
      duration: 15_000,
      position: "bottom-right",
    },
  );

  return toastId;
}
