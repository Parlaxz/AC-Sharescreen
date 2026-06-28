$file = "C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen\apps\desktop\src\renderer\services\phase3-runtime.ts"
$content = [System.IO.File]::ReadAllText($file)

# Replace fields section
$old = "  private _hostQualityLimits: HostQualityLimits = createDefaultHostQualityLimits();`r`n`r`n  /**`r`n   * Tracks which member device IDs"
$new = "  private _hostQualityLimits: HostQualityLimits = createDefaultHostQualityLimits();`r`n`r`n  /** Minimum interval between manual refreshes per group (milliseconds). */`r`n  static REFRESH_COOLDOWN_MS = 3000;`r`n`r`n  /** Last refresh timestamp per group (for cooldown). */`r`n  private refreshCooldowns = new Map<string, number>();`r`n  /** In-flight refresh promise per group (for deduplication). */`r`n  private refreshInFlight = new Map<string, Promise<void>>();`r`n`r`n  /**`r`n   * Tracks which member device IDs"
$content = $content.Replace($old, $new)

# Replace method section
$oldMethod = "  async requestGroupSync(groupId: string): Promise<void> {" + [char]13 + [char]10 + "    if (this.destroyed) return;" + [char]13 + [char]10 + [char]13 + [char]10 + "    // 1) Trigger group state anti-entropy (name/member/quality sync)" + [char]13 + [char]10 + "    await this.syncService.requestSync(groupId);" + [char]13 + [char]10 + [char]13 + [char]10 + "    // 2) Request stream state from all connected peers" + [char]13 + [char]10 + "    const conn = this.connManager.getConnection(groupId);" + [char]13 + [char]10 + "    if (conn && conn.state === " + [char]34 + "connected" + [char]34 + ") {" + [char]13 + [char]10 + "      for (const peerUuid of conn.connectedPeers) {" + [char]13 + [char]10 + "        void conn.sendToPeer(peerUuid, { type: " + [char]34 + "stream.state.request" + [char]34 + " }).catch(() => {});" + [char]13 + [char]10 + "      }" + [char]13 + [char]10 + "    }" + [char]13 + [char]10 + "  }" + [char]13 + [char]10 + "}"

$newMethod = "  requestGroupSync(groupId: string): Promise<void> | void {`r`n    if (this.destroyed) return;`r`n`r`n    // In-flight deduplication: return the active promise if one exists`r`n    const inFlight = this.refreshInFlight.get(groupId);`r`n    if (inFlight) return inFlight;`r`n`r`n    // Cooldown: skip if the last refresh was too recent`r`n    const now = Date.now();`r`n    const last = this.refreshCooldowns.get(groupId) ?? 0;`r`n    if (now - last < Phase3Runtime.REFRESH_COOLDOWN_MS) return;`r`n`r`n    const promise = this.doRequestGroupSync(groupId).finally(() => {`r`n      this.refreshCooldowns.set(groupId, Date.now());`r`n      this.refreshInFlight.delete(groupId);`r`n    });`r`n    this.refreshInFlight.set(groupId, promise);`r`n    return promise;`r`n  }`r`n`r`n  /**`r`n   * Execute the actual refresh work (not rate-limited).`r`n   * Broadcasts anti-entropy summary and actively requests`r`n   * group + stream state from all connected peers.`r`n   */`r`n  private async doRequestGroupSync(groupId: string): Promise<void> {`r`n    if (this.destroyed) return;`r`n`r`n    // 1) Trigger group state anti-entropy (name/member/quality sync)`r`n    await this.syncService.requestSync(groupId);`r`n`r`n    // 2) Actively request state from all connected peers.`r`n    //    Sends both group.state.request (explicit peer state push)`r`n    //    and stream.state.request (active stream discovery).`r`n    const conn = this.connManager.getConnection(groupId);`r`n    if (conn && conn.state === "connected") {`r`n      for (const peerUuid of conn.connectedPeers) {`r`n        void conn.sendToPeer(peerUuid, { type: "group.state.request" }).catch(() => {});`r`n        void conn.sendToPeer(peerUuid, { type: "stream.state.request" }).catch(() => {});`r`n      }`r`n    }`r`n  }`r`n}"

$content = $content.Replace($oldMethod, $newMethod)
[System.IO.File]::WriteAllText($file, $content, [System.Text.Encoding]::UTF8)
Write-Output "phase3-runtime.ts updated"

# Verify key changes exist
$c = [System.IO.File]::ReadAllText($file)
Write-Output "Has REFRESH_COOLDOWN: $($c.Contains('REFRESH_COOLDOWN_MS'))"
Write-Output "Has doRequestGroupSync: $($c.Contains('doRequestGroupSync'))"
Write-Output "Has group.state.request: $($c.Contains('group.state.request'))"
