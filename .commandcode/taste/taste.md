# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# search
- Use PowerShell `Select-String` for text search on Windows; do not use `grep` as it hangs on this machine. Confidence: 0.90

# architecture
- For viewer panel architecture: use `contentOnly` prop pattern (extract content into a `const content = (...)`, add `if (contentOnly) return <div className=\"w-[...px] p-4\">{content}</div>;` before the Popover wrapper) to enable unified panel shell rendering. Confidence: 0.85
- Use single `activePanel: \"settings\" | \"diagnostics\" | \"bandwidth\" | null` state instead of multiple boolean panel-open states for viewer popovers. Confidence: 0.85

# typescript
- For viewer settings/diagnostics/bandwidth panels, use `Fragment` import explicitly when wrapping JSX in a `const` variable assignment. Confidence: 0.60

