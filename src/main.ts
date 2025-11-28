import { ResonatePlayer } from "resonate-js";

declare global {
  interface Window {
    setStatus?: (text: string) => void;
    setDebug?: (text: string) => void;
  }
}

// Get server URL from query params or localStorage
function getBaseUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const paramUrl = params.get("server");
  if (paramUrl) {
    localStorage.setItem("resonate_server_url", paramUrl);
    return paramUrl;
  }

  const storedUrl = localStorage.getItem("resonate_server_url");
  if (storedUrl) {
    return storedUrl;
  }

  // No server configured - show error
  window.setStatus?.("No server configured. Add ?server=http://your-server:8095");
  throw new Error("No server URL configured");
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

// Initialize
async function init() {
  console.log("Resonate: Initializing Cast Receiver...");
  window.setStatus?.("Connecting...");

  const baseUrl = getBaseUrl();
  const playerId = getPlayerId();

  console.log("Resonate: Connecting to", baseUrl, "as", playerId);

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
          `Playing · ${state.volume}%${state.muted ? " (muted)" : ""}`,
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

// Start when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
