import { SendspinPlayer } from "@music-assistant/sendspin-js";

declare global {
  interface Window {
    setStatus?: (text: string) => void;
    setDebug?: (text: string) => void;
    cast?: any;
  }
}

const CAST_NAMESPACE = "urn:x-cast:sendspin";

// Cast context for sending messages back to sender
let castContext: any = null;

// Get hardware volume from Cast system (0-100 scale)
function getHardwareVolume(): { volume: number; muted: boolean } {
  if (castContext) {
    const systemVolume = castContext.getSystemVolume();
    if (systemVolume) {
      return {
        volume: Math.round(systemVolume.level * 100),
        muted: systemVolume.muted,
      };
    }
  }
  return { volume: 100, muted: false };
}

// Set hardware volume via Cast system
function setHardwareVolume(volume: number, muted: boolean): void {
  if (castContext) {
    // Cast API uses 0.0-1.0 for volume level
    castContext.setSystemVolumeLevel(volume / 100);
    castContext.setSystemVolumeMuted(muted);
    console.log("Sendspin: Set hardware volume:", volume, "muted:", muted);
  }
}

// Send status update to sender
function sendStatusToSender(status: {
  state: "connecting" | "connected" | "playing" | "stopped" | "error";
  message?: string;
  sync?: { synced: boolean; offset?: number; error?: number };
  syncInfo?: { clockDriftPercent: number; syncErrorMs: number; resyncCount: number };
  volume?: number;
  muted?: boolean;
}) {
  if (castContext) {
    castContext.sendCustomMessage(CAST_NAMESPACE, undefined, status);
  }
}

// Player ID, name, sync delay, and codecs provided by the sender (Music Assistant server)
let providedPlayerId: string | null = null;
let providedPlayerName: string | null = null;
let providedSyncDelay: number = 0;
let providedCodecs: string[] | null = null;

// Track current connection settings (for detecting changes that require reconnect)
let currentServerUrl: string | null = null;
let currentPlayerCodecs: string[] | null = null;

// Generate or get player ID (persisted in localStorage)
function getPlayerId(): string {
  // If a player ID was provided by the sender, use it
  if (providedPlayerId) {
    localStorage.setItem("sendspin_player_id", providedPlayerId);
    return providedPlayerId;
  }

  const params = new URLSearchParams(window.location.search);
  const paramId = params.get("player_id");
  if (paramId) {
    localStorage.setItem("sendspin_player_id", paramId);
    return paramId;
  }

  // Check localStorage for existing ID
  const storedId = localStorage.getItem("sendspin_player_id");
  if (storedId) {
    return storedId;
  }

  // Generate and store a new ID
  const newId = `cast-${Math.random().toString(36).substring(2, 10)}`;
  localStorage.setItem("sendspin_player_id", newId);
  return newId;
}

// Update debug info
function updateDebug(player: SendspinPlayer) {
  const sync = player.timeSyncInfo;
  const info = player.syncInfo;
  const format = player.currentFormat;

  let debugText = sync.synced
    ? `offset: ${sync.offset}ms ±${sync.error}ms`
    : "sync: waiting...";

  // Add sync info: clock drift, sync error, resync count
  const driftSign = info.clockDriftPercent >= 0 ? "+" : "";
  debugText += ` · drift: ${driftSign}${info.clockDriftPercent.toFixed(2)}%`;
  debugText += ` · error: ${info.syncErrorMs.toFixed(1)}ms`;
  debugText += ` · resyncs: ${info.resyncCount}`;

  if (format) {
    debugText += ` · ${format.codec} ${format.sample_rate / 1000}kHz/${format.bit_depth || 16}bit`;
  }

  window.setDebug?.(debugText);
}

// Track current player state for periodic updates
let currentPlayerState: {
  isPlaying: boolean;
} = { isPlaying: false };

// Connect to Sendspin server
async function connectToServer(baseUrl: string) {
  // Cleanup existing player before creating new one
  const existingPlayer = (window as any).player as SendspinPlayer | undefined;
  if (existingPlayer) {
    console.log("Sendspin: Disconnecting existing player before reconnect");
    existingPlayer.disconnect();
  }

  const playerId = getPlayerId();

  console.log("Sendspin: Connecting to", baseUrl, "as", playerId);
  window.setStatus?.("Connecting...");
  sendStatusToSender({ state: "connecting", message: "Connecting to server..." });

  // Use provided name or default
  const clientName = providedPlayerName || "Music Assistant Cast Receiver";

  console.log("Sendspin: Using sync delay:", providedSyncDelay, "ms");

  const player = new SendspinPlayer({
    playerId,
    baseUrl,
    // Cast receiver config
    audioOutputMode: "direct", // Output directly to audioContext.destination
    clientName,
    syncDelay: providedSyncDelay,
    bufferCapacity: 1024 * 1024 * 2, // 2MB (GC4A memory constraint)
    // Use codecs from sender config, default to PCM for maximum compatibility
    codecs: providedCodecs ?? ["pcm"],
    // Use hardware volume control (Cast system volume)
    useHardwareVolume: true,
    onVolumeCommand: setHardwareVolume,
    getExternalVolume: getHardwareVolume,
    useOutputLatencyCompensation: true,
    onStateChange: (state) => {
      currentPlayerState = {
        isPlaying: state.isPlaying,
      };
      const hwVol = getHardwareVolume();
      if (state.isPlaying) {
        window.setStatus?.(
          `Playing · Volume: ${hwVol.volume}%${hwVol.muted ? " (muted)" : ""}`,
        );
      } else {
        window.setStatus?.("Stopped");
      }
      sendPlayerStatus(player);
      updateDebug(player);
    },
  });

  try {
    await player.connect();
    console.log("Sendspin: Connected - ready to play");
    window.setStatus?.("Ready to play");
    sendStatusToSender({ state: "connected", message: "Ready to play" });

    // Periodically send status to sender
    setInterval(() => {
      updateDebug(player);
      sendPlayerStatus(player);
    }, 1000);
  } catch (error) {
    console.error("Sendspin: Connection failed:", error);
    window.setStatus?.("Connection failed");
    sendStatusToSender({ state: "error", message: "Connection failed" });
  }

  // Expose player globally for debugging
  (window as any).player = player;

  // Track current connection settings for change detection
  currentServerUrl = baseUrl;
  currentPlayerCodecs = providedCodecs ?? ["pcm"];
}

// Send current player status to sender
function sendPlayerStatus(player: SendspinPlayer) {
  const sync = player.timeSyncInfo;
  const info = player.syncInfo;
  const hwVol = getHardwareVolume();
  sendStatusToSender({
    state: currentPlayerState.isPlaying ? "playing" : "stopped",
    volume: hwVol.volume,
    muted: hwVol.muted,
    sync: { synced: sync.synced, offset: sync.offset, error: sync.error },
    syncInfo: info,
  });
}

// Detect if running on a Chromecast device (user agent contains "CrKey")
function isRunningOnChromecast(): boolean {
  return navigator.userAgent.includes("CrKey");
}

// Initialize Cast Receiver
function initCastReceiver() {
  // Redirect to sender page if not running on a Cast device
  if (!isRunningOnChromecast()) {
    console.log("Sendspin: Not running on Cast device, redirecting to sender...");
    window.location.href = "./sender.html";
    return;
  }

  const castFramework = window.cast?.framework;
  const context = castFramework?.CastReceiverContext?.getInstance();

  if (!context) {
    console.log("Sendspin: Cast SDK not available");
    window.setStatus?.("Cast SDK error");
    return;
  }

  // Store context for sending messages back to sender
  castContext = context;

  console.log("Sendspin: Initializing Cast Receiver...");
  window.setStatus?.("Waiting for sender...");

  // Listen for system (hardware) volume changes
  context.addEventListener(castFramework.system.EventType.SYSTEM_VOLUME_CHANGED, (event: any) => {
    console.log("Sendspin: System volume changed:", event.data);
    const hwVol = getHardwareVolume();
    window.setStatus?.(
      currentPlayerState.isPlaying
        ? `Playing · Volume: ${hwVol.volume}%${hwVol.muted ? " (muted)" : ""}`
        : "Stopped",
    );
    // Send volume update to sender
    const player = (window as any).player as SendspinPlayer | undefined;
    if (player) {
      sendPlayerStatus(player);
    } else {
      // No player yet, send basic volume update
      sendStatusToSender({
        state: "connected",
        volume: hwVol.volume,
        muted: hwVol.muted,
      });
    }
  });

  // Cast event listeners
  context.addEventListener(castFramework.system.EventType.READY, () => {
    console.log("Sendspin: Cast receiver READY");
  });

  context.addEventListener(castFramework.system.EventType.SENDER_CONNECTED, () => {
    console.log("Sendspin: Sender connected");
  });

  context.addEventListener(castFramework.system.EventType.SENDER_DISCONNECTED, () => {
    console.log("Sendspin: Sender disconnected");
    window.setStatus?.("Disconnected");
  });

  context.addEventListener(castFramework.system.EventType.ERROR, (event: any) => {
    console.error("Sendspin: Cast error:", event);
  });

  // Listen for custom messages with server URL, player ID, name, and sync delay
  context.addCustomMessageListener(CAST_NAMESPACE, (event: any) => {
    console.log("Sendspin: Received message from sender:", event.data);
    const serverUrl = event.data?.serverUrl;
    const playerId = event.data?.playerId;
    const playerName = event.data?.playerName;
    const syncDelay = event.data?.syncDelay;
    const codecs = event.data?.codecs;
    if (Array.isArray(codecs) && codecs.every((c) => ["pcm", "flac", "opus"].includes(c))) {
      providedCodecs = codecs;
      console.log("Sendspin: Using codecs from sender:", codecs);
    }
    if (playerId) {
      // Store the player ID provided by Music Assistant
      providedPlayerId = playerId;
      console.log("Sendspin: Using player ID from sender:", playerId);
    }
    if (playerName) {
      // Store the player name provided by Music Assistant
      providedPlayerName = playerName;
      console.log("Sendspin: Using player name from sender:", playerName);
    }
    if (typeof syncDelay === "number") {
      // Store the sync delay provided by Music Assistant
      providedSyncDelay = syncDelay;
      console.log("Sendspin: Using sync delay from sender:", syncDelay, "ms");
      // Update existing player if already connected
      const existingPlayer = (window as any).player as SendspinPlayer | undefined;
      if (existingPlayer) {
        existingPlayer.setSyncDelay(syncDelay);
        console.log("Sendspin: Updated sync delay on existing player");
      }
    }
    // Check if codecs changed on an existing player - requires reconnect
    const existingPlayer = (window as any).player as SendspinPlayer | undefined;
    if (existingPlayer && currentPlayerCodecs && providedCodecs) {
      const codecsChanged = JSON.stringify(providedCodecs) !== JSON.stringify(currentPlayerCodecs);
      if (codecsChanged) {
        console.log("Sendspin: Codecs changed, reconnecting...");
        connectToServer(serverUrl ?? currentServerUrl!);
        return;
      }
    }

    if (serverUrl) {
      connectToServer(serverUrl);
    }
  });

  // Start the Cast receiver with options
  const options = new castFramework.CastReceiverOptions();
  options.disableIdleTimeout = true;
  options.maxInactivity = 3600; // 1 hour max inactivity

  context.start(options);
  console.log("Sendspin: Cast Receiver started");
}

// Start when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCastReceiver);
} else {
  initCastReceiver();
}
