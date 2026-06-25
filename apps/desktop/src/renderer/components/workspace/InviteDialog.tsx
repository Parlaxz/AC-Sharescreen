import { useCallback, useEffect, useState } from "react";
import { Copy, Check, X } from "lucide-react";
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
import { copyGroupInviteFromUi, getInviteCopyDeps } from "@/services/invite-copy";

/**
 * InviteDialog — Dialog for sharing a real, generated group invite
 * link. The link is resolved from the preload `getGroupInvite` API
 * and copied to the clipboard via the preload `clipboardWriteText`
 * API. The dialog does not fabricate invite URLs.
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
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Resolve the real invite link from the preload API when the
  // dialog opens. The link is never fabricated locally.
  useEffect(() => {
    if (!open) {
      setInviteLink(null);
      setResolved(false);
      setResolveError(null);
      setCopied(false);
      return;
    }
    let cancelled = false;
    const deps = getInviteCopyDeps();
    if (!deps) {
      setResolveError("Invite service is unavailable");
      setResolved(true);
      return;
    }
    deps
      .getGroupInvite(groupId)
      .then((invite) => {
        if (cancelled) return;
        if (invite && typeof invite.link === "string" && invite.link.length > 0) {
          setInviteLink(invite.link);
        } else {
          setResolveError("No invite available for this group");
        }
        setResolved(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResolveError(err instanceof Error ? err.message : "Failed to load invite");
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, groupId]);

  const handleCopy = useCallback(async () => {
    if (!inviteLink) return;
    const result = await copyGroupInviteFromUi(groupId, "Invite link copied");
    if (result.success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [groupId, inviteLink]);

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
            value={
              inviteLink ??
              (resolved
                ? resolveError ?? "Resolving invite…"
                : "Resolving invite…")
            }
            aria-label="Invite link"
            className="flex-1"
            placeholder="Resolving invite…"
            disabled={!inviteLink}
          />
          <Button
            variant="default"
            size="icon"
            onClick={handleCopy}
            disabled={!inviteLink}
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
