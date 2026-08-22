import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useStore } from "@/stores/main-store";

/**
 * CommandPalette — Ctrl+K command palette (Section 14).
 *
 * Shows a searchable list of all available actions with keyboard hints.
 * Used by useKeyboardShortcuts hook.
 */
interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CommandActionItem {
  label: string;
  shortcut: string;
  disabled?: boolean;
  disabledReason?: string;
  action: () => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useStore((s) => s.navigate);
  const toggleContextPanel = useStore((s) => s.toggleContextPanel);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const isSharing = useStore((s) => s.isSharing);
  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);
  const selectedGroupId = useStore((s) => s.selectedGroupId);

  const commandActions: { group: string; items: CommandActionItem[] }[] = [
    {
      group: "Navigation",
      items: [
        { label: "Open settings", shortcut: "Ctrl+,", action: () => navigate("user-settings") },
        { label: "Open diagnostics", shortcut: "", action: () => navigate("diagnostics") },
        { label: "Open my presets", shortcut: "", action: () => navigate("quality-presets") },
        { label: "Open about", shortcut: "", action: () => navigate("about") },
      ],
    },
    {
      group: "Sharing",
      items: [
        {
          label: isSharing ? "Stop sharing" : "Start sharing",
          shortcut: "Ctrl+Shift+S",
          action: () => {
            if (isSharing) {
              useStore.getState().setIsSharing(false);
            } else {
              setOpenShareSetup(true);
            }
          },
        },
      ],
    },
    {
      group: "View",
      items: [
        { label: "Toggle context panel", shortcut: "Ctrl+`", action: () => toggleContextPanel() },
        { label: "Toggle focus mode", shortcut: "Ctrl+Shift+F", action: () => toggleFocusMode() },
      ],
    },
    {
      group: "Actions",
      items: [
        {
          label: "Open invite dialog",
          shortcut: "",
          disabled: !selectedGroupId,
          disabledReason: "Select a group first",
          action: () => {
            // Will be wired to the group dashboard's invite dialog
          },
        },
      ],
    },
  ];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {commandActions.map((group) => (
          <CommandGroup key={group.group} heading={group.group}>
            {group.items.map((item) => {
              const isDisabled = "disabled" in item ? item.disabled : false;
              return (
                <CommandItem
                  key={item.label}
                  disabled={isDisabled}
                  onSelect={() => {
                    if (isDisabled) return;
                    item.action();
                    onOpenChange(false);
                  }}
                  className={cn(
                    isDisabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <span className="flex-1">{item.label}</span>
                  {isDisabled && item.disabledReason && (
                    <span className="text-[10px] text-text-muted ml-2">
                      {item.disabledReason}
                    </span>
                  )}
                  {!isDisabled && item.shortcut && (
                    <kbd className="ml-auto text-[10px] text-text-muted bg-surface-2 px-1.5 py-0.5 rounded-compact">
                      {item.shortcut}
                    </kbd>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
