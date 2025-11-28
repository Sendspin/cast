import { ResonatePlayer } from "resonate-js";

declare global {
  interface Window {
    setStatus?: (text: string) => void;
    setDebug?: (text: string) => void;
    cast?: any;
  }
}

const CAST_NAMESPACE = "urn:x-cast:resonate";

// Get server URL from query params (for local testing)
function getBaseUrlFromParams(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("server");
}

// Generate or get player ID (persisted in localStorage)
function getPlayerId(): string {
  const params = new URLSearchParams(window.location.search);
  const paramId = params.get("player_id");
  if (paramId) {
    localStorage.setItem("resonate_player_id", paramId);
    return paramId;
  }

  // Check localStorage for existing ID
  const storedId = localStorage.getItem("resonate_player_id");
  if (storedId) {
    return storedId;
  }

  // Generate and store a new ID
  const newId = `cast-${Math.random().toString(36).substring(2, 10)}`;
  localStorage.setItem("resonate_player_id", newId);
  return newId;
}

// Update debug info
function updateDebug(player: ResonatePlayer) {
  const sync = player.timeSyncInfo;
  const format = player.currentFormat;

  let debugText = sync.synced
    ? `sync: ${sync.offset}ms ±${sync.error}ms`
    : "sync: waiting...";

  if (format) {
    debugText += ` · ${format.codec} ${format.sample_rate / 1000}kHz/${format.bit_depth || 16}bit`;
  }

  window.setDebug?.(debugText);
}

// Connect to Resonate server
async function connectToServer(baseUrl: string) {
  const playerId = getPlayerId();

  console.log("Resonate: Connecting to", baseUrl, "as", playerId);
  window.setStatus?.("Connecting to " + baseUrl);

  const player = new ResonatePlayer({
    playerId,
    baseUrl,
    // Cast receiver config
    audioOutputMode: "direct", // Output directly to audioContext.destination
    clientName: "Music Assistant Cast Receiver",
    bufferCapacity: 1024 * 1024 * 1.5, // 1.5MB (GC4A memory constraint)
    supportedFormats: [
      // PCM only for GC4A 2.0 compatibility (no decodeAudioData for FLAC/Opus)
      { codec: "pcm", sample_rate: 48000, channels: 2, bit_depth: 16 },
      { codec: "pcm", sample_rate: 44100, channels: 2, bit_depth: 16 },
    ],
    onStateChange: (state) => {
      if (state.isPlaying) {
        window.setStatus?.(
          `Playing · Volume: ${state.volume}%${state.muted ? " (muted)" : ""}`,
        );
      } else {
        window.setStatus?.("Stopped");
      }
      updateDebug(player);
    },
  });

  try {
    await player.connect();
    console.log("Resonate: Connected - waiting for stream...");
    window.setStatus?.("Connected · Waiting for stream");

    // Periodically update debug info
    setInterval(() => updateDebug(player), 1000);
  } catch (error) {
    console.error("Resonate: Connection failed:", error);
    window.setStatus?.("Connection failed");
  }

  // Expose player globally for debugging
  (window as any).player = player;
}

// Initialize Cast Receiver
function initCastReceiver() {
  const castFramework = window.cast?.framework;
  const context = castFramework?.CastReceiverContext?.getInstance();

  if (!context) {
    console.log("Resonate: Cast SDK not available, checking query params...");
    // Fallback for local testing without Cast SDK
    const paramUrl = getBaseUrlFromParams();
    if (paramUrl) {
      connectToServer(paramUrl);
    } else {
      window.setStatus?.("No server configured. Add ?server=http://ip:8927");
    }
    return;
  }

  console.log("Resonate: Initializing Cast Receiver...");
  window.setStatus?.("Waiting for sender...");

  // Cast event listeners
  context.addEventListener(castFramework.system.EventType.READY, () => {
    console.log("Resonate: Cast receiver READY");
  });

  context.addEventListener(castFramework.system.EventType.SENDER_CONNECTED, () => {
    console.log("Resonate: Sender connected");
  });

  context.addEventListener(castFramework.system.EventType.SENDER_DISCONNECTED, () => {
    console.log("Resonate: Sender disconnected");
    window.setStatus?.("Disconnected");
  });

  context.addEventListener(castFramework.system.EventType.ERROR, (event: any) => {
    console.error("Resonate: Cast error:", event);
  });

  // Listen for custom messages with server URL
  context.addCustomMessageListener(CAST_NAMESPACE, (event: any) => {
    console.log("Resonate: Received message from sender:", event.data);
    const serverUrl = event.data?.serverUrl;
    if (serverUrl) {
      connectToServer(serverUrl);
    }
  });

  // Start the Cast receiver with options
  const options = new castFramework.CastReceiverOptions();
  options.disableIdleTimeout = true;
  options.maxInactivity = 3600; // 1 hour max inactivity

  context.start(options);
  console.log("Resonate: Cast Receiver started");
}

// Start when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCastReceiver);
} else {
  initCastReceiver();
}
