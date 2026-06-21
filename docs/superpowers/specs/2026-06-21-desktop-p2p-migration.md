# ScreenLink Desktop P2P Migration

## Summary

Remove the Cloudflare Worker + browser viewer architecture. Replace with a pure desktop-to-desktop model where both users run the same Electron app. A persistent VDO.Ninja data-channel connection handles presence and control messages. Media sharing uses ephemeral VDO.Ninja streams with credentials exchanged through the control channel.

## Architecture

Each ScreenLink app maintains three independent VDO.Ninja SDK connections:

1. **Control SDK**: Persistent data-only connection (via `announce()`). Stays alive while the app is in the tray. Carries pairing presence, shares state, credential exchange, quality requests, ping/pong.

2. **Media Publisher**: Temporary connection, created when the local user shares. Publishes a screen/window capture stream with ephemeral credentials.

3. **Media Viewer**: Temporary connection, created when the remote peer shares. Receives and renders the remote stream.

Both users can share simultaneously. Sharing and viewing are independent state machines.

## Key APIs Used

- `new VDONinjaSDK({ password, host, salt })` — Constructor
- `sdk.connect()` — Connect to signaling
- `sdk.announce({ streamID, room, label })` — Data-only presence (control channel)
- `sdk.joinRoom({ room, password })` — Join a room for peer discovery
- `sdk.publish(stream, { streamID, room, label, password, videoBitrate, ... })` — Publish media
- `sdk.view(streamID, { audio, video, label })` — View a stream
- `sdk.stopPublishing()` — Stop publishing
- `sdk.stopViewing()` — Stop viewing
- `sdk.sendData(data, { uuid, type, allowFallback: false })` — Data channel send
- `sdk.on(event, handler)` — Event listener
- Events: `connected`, `disconnected`, `publishing`, `peerConnected`, `peerDisconnected`, `dataChannelOpen`, `dataChannelClose`, `dataReceived`, `track`, `error`

## Control Protocol

Envelope: `{ screenlink: { version: 1, type, messageId, sentAt, senderDeviceId, payload } }`

Messages: `peer.hello`, `peer.hello.response`, `state.request`, `state.response`, `share.started`, `share.updated`, `share.stopped`, `quality.request`, `quality.applied`, `quality.rejected`, `ping`, `pong`

## Pairing

Create Pairing → generates `pairId` (128 bits), `pairSecret` (256 bits), `deviceId` (UUID), `displayName`. Transfer via copy/paste or file. PairSecret stored in Electron safeStorage.

## State Machines

Local sharing: `idle → selecting-source → starting → sharing → stopping → idle`
Remote viewing: `remote-offline → remote-online-idle → share-available → connecting → viewing → idle`
