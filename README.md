# Sendspin over Cast

Chromecast receiver for Music Assistant using the Sendspin protocol. It runs a custom Cast receiver web app that connects to a Sendspin server over WebSocket using the Sendspin JS SDK.

- Receiver app: `src/main.ts` (built to `dist/assets/receiver-*.js` and loaded by `dist/receiver.html`)
- Sender demo page: `html/index.html` (built to `dist/index.html`) to configure server IP, codec, and sync delay, then send those to the receiver via a custom Cast namespace.

## Quick Start

Prerequisites:
- Node 18+
- Yarn 1.x (or npm)
- A Chromecast/Google TV/Cast Audio device on your network

Install and build:

```
yarn
yarn build
```

Then open `dist/index.html` in Chrome to use the sender demo. It discovers Cast devices via the Cast sender SDK and sends configuration to the receiver app.

To preview the static build locally:

```
yarn preview
```

## How It Works

- The sender page (`dist/index.html`) lets you enter the Music Assistant server host, preferred codec, and sync delay.
- When you cast, it launches the receiver app (`dist/receiver.html`) on the Cast device and sends a message over the custom namespace `urn:x-cast:sendspin` with `{ serverUrl, codecs, syncDelay }`.
- The receiver creates a Sendspin JS SDK player, connects to `${serverUrl}/sendspin`, and streams audio directly to the device using Web Audio (direct output mode) with hardware volume integration.

## SDK Usage in the Receiver

The receiver uses the constructor + connect pattern with an explicit `baseUrl`:

```ts
import { SendspinPlayer } from "@music-assistant/sendspin-js";

// Inside connectToServer(baseUrl: string)
const player = new SendspinPlayer({
  playerId,               // deterministic ID stored in localStorage or provided by sender
  baseUrl,                // e.g. "http://192.168.1.100:8927"
  audioOutputMode: "direct",
  clientName,             // e.g. "Music Assistant Cast Receiver"
  syncDelay: providedSyncDelay,
  bufferCapacity: 1024 * 1024 * 2, // 2MB (GC4A memory constraint)
  codecs: providedCodecs ?? ["pcm"],
  useHardwareVolume: true,
  onVolumeCommand: setHardwareVolume,
  getExternalVolume: getHardwareVolume,
  onStateChange: (state) => {
    // Update UI + report status back to sender
  },
});

await player.connect();
```

Notes:
- `baseUrl` is required and should be the HTTP(S) origin of the Sendspin server; the SDK connects to `ws(s)://<host>/sendspin`.
- MediaSession is managed by the SDK by default; on Cast we rely on hardware volume callbacks from the Cast SDK instead.
- `audioOutputMode: "direct"` routes audio to `audioContext.destination`, which is appropriate for Cast receivers.

## Cast Message Protocol

All messages between sender and receiver use the custom namespace `urn:x-cast:sendspin`. Each message includes a `type` field to identify the message type.

### Sender → Receiver Messages

**Config message** (`type: "config"`): Sent to configure the receiver connection.

```json
{
  "type": "config",
  "serverUrl": "http://192.168.1.100:8927",
  "playerId": "cast-abc123",
  "playerName": "Living Room Speaker",
  "syncDelay": 0,
  "codecs": ["flac"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No* | Message type (`"config"`). Optional for backwards compatibility. |
| `serverUrl` | string | No | Sendspin server URL. Triggers connection when changed. |
| `playerId` | string | No | Player ID override. |
| `playerName` | string | No | Friendly name for the player. |
| `syncDelay` | number | No | Sync delay in milliseconds (can be negative). |
| `codecs` | string[] | No | Audio codecs: `["flac"]`, `["opus"]`, or `["pcm"]`. |

**Set volume message** (`type: "set_volume"`): Sent to control hardware volume.

```json
{
  "type": "set_volume",
  "volume": 50
}
```

### Receiver → Sender Messages

**Status message** (`type: "status"`): Sent periodically to report player state.

```json
{
  "type": "status",
  "state": "playing",
  "message": "Ready to play",
  "volume": 75,
  "muted": false,
  "sync": { "synced": true, "offset": 5, "error": 2 },
  "syncInfo": { "clockDriftPercent": 0.01, "syncErrorMs": 1.5, "resyncCount": 0 }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Message type (`"status"`). |
| `state` | string | One of: `"connecting"`, `"connected"`, `"playing"`, `"stopped"`, `"error"`. |
| `message` | string | Human-readable status message. |
| `volume` | number | Hardware volume (0-100). |
| `muted` | boolean | Mute state. |
| `sync` | object | Time sync info: `synced`, `offset` (ms), `error` (ms). |
| `syncInfo` | object | Detailed sync metrics: `clockDriftPercent`, `syncErrorMs`, `resyncCount`. |

## Development

Run a dev server and hack on the receiver UI (requires network for Cast SDK):

```
yarn dev
```

This serves the sender page on localhost (with the Cast sender SDK) and builds receiver assets for the target device.

## License

Apache-2.0
