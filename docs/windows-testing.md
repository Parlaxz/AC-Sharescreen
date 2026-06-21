# Windows Testing

## Test Matrix

- Windows 10 22H2
- Windows 11 24H2
- Single monitor
- Dual monitors
- 100%, 125%, 150% DPI scaling
- Monitor capture
- Window capture
- System audio on/off

## Test Cases

1. **Close-to-tray**: Window close hides to tray, process continues
2. **Login startup**: App launches at Windows login with --hidden
3. **Sleep/resume**: App recovers from sleep without crash
4. **Monitor disconnect**: Graceful handling with notification
5. **Source close**: Window capture ends when source closes
6. **Network interruption**: Reconnection on network restore
7. **Host restart**: Viewer reconnects automatically
8. **Viewer restart**: Viewer reconnects automatically
