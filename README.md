# Sendspin over Cast

Chromecast receiver for Sendspin. It runs a custom Cast receiver web app that connects to a Sendspin server over WebSocket using the Sendspin JS SDK.

- Receiver app: `src/main.ts` (built to `dist/assets/receiver-*.js` and loaded by `dist/receiver.html`)
- Sender demo page: `html/index.html` (built to `dist/index.html`) to control the cast receiver.

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

- The sender page (`dist/index.html`) lets you enter the Sendspin server host, preferred codec, and sync delay.
- When you cast, it launches the receiver app (`dist/receiver.html`) on the Cast device and sends a message over the custom namespace `urn:x-cast:sendspin` with `{ serverUrl, codecs, syncDelay }`.
- The receiver creates a Sendspin JS SDK player, connects to `${serverUrl}/sendspin`, and streams audio directly to the device using Web Audio (direct output mode) with hardware volume integration.

## Cast Message Protocol

All messages between sender and receiver use the custom namespace `urn:x-cast:sendspin`. Each message includes a `type` field to identify the message type.

### Sender → Receiver Messages

**Config message** (`type: "config"`): Sent to the receiver to configure the connection.

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

### Receiver → Sender Messages

**Status message** (`type: "status"`): Sent periodically by the receiver to report player state.

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

## Development Setup

To develop and test the Cast receiver, you need to set up a Cast developer account and register a custom receiver app.

1. Go to the [Google Cast SDK Developer Console](https://cast.google.com/publish/#/overview) and sign in with your Google account.
2. Create a new application and select "Custom Receiver".
3. Set the receiver URL to a accessible URL where your dev server hosts the receiver (e.g., `http://<your-ip>:4173/receiver.html`).
4. Note the Application ID assigned to your app.

## Development

Run a dev server and hack on the receiver UI (requires network for Cast SDK):

```
yarn dev
```

This serves the sender page on localhost (with the Cast sender SDK) and builds receiver assets for the target device.

## License

Apache-2.0
