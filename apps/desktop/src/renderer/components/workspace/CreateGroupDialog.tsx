import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { useStore } from "@/stores/main-store";
import { createGroupAction } from "@/services/group-actions";

/**
 * CreateGroupDialog — Shared dialog for creating a new group.
 *
 * Uses the real createGroup preload API. On success:
 * - Updates the store immediately
 * - Selects the new group
 * - Navigates to the group overview
 * - Closes the dialog
 * - Shows success toast
 *
 * Can be opened from HomePage and GroupRail via the shared
 * openCreateGroupDialog store flag.
 */
export function CreateGroupDialog() {
  const open = useStore((s) => s.openCreateGroupDialog);
  const setOpen = useStore((s) => s.setOpenCreateGroupDialog);

  const [groupName, setGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    const trimmed = groupName.trim();
    if (!trimmed || creating) return;

    setCreating(true);
    setError(null);

    try {
      await createGroupAction(trimmed);
      toast.success(`Group "${trimmed}" created`);
      setOpen(false);
      setGroupName("");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create group";
      setError(message);
    } finally {
      setCreating(false);
    }
  }, [groupName, creating, setOpen]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setOpen(open);
      if (!open) {
        setGroupName("");
        setError(null);
      }
    },
    [setOpen],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !creating && groupName.trim()) {
        e.preventDefault();
        void handleCreate();
      }
    },
    [handleCreate, creating, groupName],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create group</DialogTitle>
          <DialogDescription>
            Give your new group a name. You can invite members after creating
            it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="create-group-name">Group name</Label>
            <Input
              id="create-group-name"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="My Team"
              disabled={creating}
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={creating}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="default"
            disabled={!groupName.trim() || creating}
            onClick={handleCreate}
          >
            {creating ? "Creating…" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
