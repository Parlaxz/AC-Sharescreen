import { useCallback, useState } from "react";
import { Copy, Check, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * InviteDialog — Watermelon Dialog for sharing an invite link (Section 8.1 / 6.1).
 *
 * Props:
 *   open       — controlled open state
 *   onOpenChange — callback when dialog closes
 *   groupName  — name of the group (for the description)
 *   groupId    — used to construct the invite link
 *
 * Composed from Watermelon: Dialog, Input, Button.
 * Uses navigator.clipboard.writeText with sonner toast feedback.
 */
interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  groupId: string;
}

export function InviteDialog({
  open,
  onOpenChange,
  groupName,
  groupId,
}: InviteDialogProps) {
  // Construct the invite link — placeholder until real invite service is wired
  const inviteLink = `https://screenlink.app/invite/${groupId}`;

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
    } catch {
      // Fallback for older contexts
      const ta = document.createElement("textarea");
      ta.value = inviteLink;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    toast("Invite link copied");
    // Reset copied state after a moment
    setTimeout(() => setCopied(false), 2000);
  }, [inviteLink]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite members</DialogTitle>
          <DialogDescription>
            Share this link with friends to invite them to{" "}
            <span className="font-medium text-text-primary">{groupName}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 pt-2">
          <Input
            readOnly
            value={inviteLink}
            aria-label="Invite link"
            className="flex-1"
          />
          <Button
            variant="default"
            size="icon"
            onClick={handleCopy}
            aria-label={copied ? "Copied" : "Copy invite link"}
            className="flex-shrink-0"
          >
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </div>

        <div className="flex justify-end pt-2">
          <DialogClose asChild>
            <Button variant="outline" aria-label="Close">
              Close
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
