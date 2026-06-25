import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
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

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useStore((s) => s.navigate);
  const toggleContextPanel = useStore((s) => s.toggleContextPanel);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const isSharing = useStore((s) => s.isSharing);
  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);

  const commandActions = [
    {
      group: "Navigation",
      items: [
        { label: "Open settings", shortcut: "Ctrl+,", action: () => navigate("user-settings") },
        { label: "Open diagnostics", shortcut: "", action: () => navigate("diagnostics") },
        { label: "Open group presets", shortcut: "", action: () => navigate("group-presets") },
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
          action: () => {
            // Will be wired to the group dashboard's invite dialog
          },
        },
      ],
    },
  ];

  const toast = (msg: string) => {
    console.log("[CommandPalette]", msg);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {commandActions.map((group) => (
          <CommandGroup key={group.group} heading={group.group}>
            {group.items.map((item) => (
              <CommandItem
                key={item.label}
                onSelect={() => {
                  item.action();
                  onOpenChange(false);
                }}
              >
                <span className="flex-1">{item.label}</span>
                {item.shortcut && (
                  <kbd className="ml-auto text-[10px] text-text-muted bg-surface-2 px-1.5 py-0.5 rounded-compact">
                    {item.shortcut}
                  </kbd>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
