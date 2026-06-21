# Troubleshooting

## Common Issues

### SDK not loading
- Check that `vdoninja-sdk-1.3.18.min.js` exists in `public/vendor/`
- Verify SHA-256 with `pnpm verify-sdk`
- Check browser console for version mismatch errors

### No sources found
- Run desktop app with admin privileges if needed
- Check that screen/window capture is not blocked by group policy

### Viewer shows "offline"
- Verify the Worker is deployed and accessible
- Check host token in desktop settings
- Verify viewer link has correct share ID and token

### TURN relay instead of direct
- Check if a firewall/NAT is blocking direct peer connections
- TURN is expected in restrictive networks

### High bandwidth usage
- Review per-viewer video ceiling settings
- Check actual bitrate in diagnostics
- Verify sender parameters are being applied
