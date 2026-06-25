import { useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  SheetClose,
} from "@/components/ui/sheet";

/**
 * SettingsSheet — Compact settings form used by UserDock (Section 7.3).
 *
 * Provides quick-access to the most common settings without navigating
 * to the full Settings page.
 */
interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsSheet({ open, onOpenChange }: SettingsSheetProps) {
  const [displayName, setDisplayName] = useState("User");
  const [defaultPreset, setDefaultPreset] = useState("balanced");
  const [defaultAudio, setDefaultAudio] = useState("application");
  const [defaultCodec, setDefaultCodec] = useState("h264");

  const handleSave = () => {
    toast("Settings saved");
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>
            Quick settings — open the full Settings page for more options.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sheet-display-name">Display name</Label>
            <Input
              id="sheet-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sheet-default-preset">Default preset</Label>
            <Select value={defaultPreset} onValueChange={setDefaultPreset}>
              <SelectTrigger id="sheet-default-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="data-saver">Data saver</SelectItem>
                <SelectItem value="balanced">Balanced</SelectItem>
                <SelectItem value="clear">Clear</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sheet-default-audio">Default audio mode</Label>
            <Select value={defaultAudio} onValueChange={setDefaultAudio}>
              <SelectTrigger id="sheet-default-audio">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No audio</SelectItem>
                <SelectItem value="application">Application audio</SelectItem>
                <SelectItem value="system">System audio</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sheet-default-codec">Default codec</Label>
            <Select value={defaultCodec} onValueChange={setDefaultCodec}>
              <SelectTrigger id="sheet-default-codec">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="h264">H264</SelectItem>
                <SelectItem value="vp8">VP8</SelectItem>
                <SelectItem value="vp9">VP9</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <SheetFooter className="mt-6">
          <SheetClose asChild>
            <Button variant="outline">Cancel</Button>
          </SheetClose>
          <Button onClick={handleSave}>Save</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
