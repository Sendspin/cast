import { SendspinPlayer, ServerStateMetadata } from "@sendspin/sendspin-js";

// Manual type - @types/chromecast-caf-receiver is missing volume methods
// Matches cast.framework.system.SystemVolumeData from the actual SDK
interface SystemVolumeData {
  level: number;
  muted: boolean;
}

interface NowPlayingMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
}

declare global {
  interface Window {
    setStatus?: (text: string) => void;
    setPlaybackState?: (isPlaying: boolean) => void;
    setDebug?: (text: string) => void;
    setNowPlaying?: (metadata: NowPlayingMetadata | null) => void;
    setVolume?: (level: number, muted: boolean) => void;
    setProgress?: (currentSeconds: number, totalSeconds: number) => void;
    showError?: (context: string, error: unknown) => void;
  }
}

// Convert server metadata to UI metadata format
function toNowPlayingMetadata(
  metadata: ServerStateMetadata,
): NowPlayingMetadata {
  return {
    title: metadata.title ?? undefined,
    artist: metadata.artist ?? undefined,
    album: metadata.album ?? undefined,
    artworkUrl: metadata.artwork_url ?? undefined,
  };
}

const CAST_NAMESPACE = "urn:x-cast:sendspin";

// In-memory storage (avoids localStorage writes on Cast devices)
const sessionStorage = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => sessionStorage.get(key) ?? null,
  setItem: (key: string, value: string) => sessionStorage.set(key, value),
};

const KNOWN_CODECS = ["pcm", "flac", "opus"] as const;
type Codec = (typeof KNOWN_CODECS)[number];
const DEFAULT_CODECS: Codec[] = ["pcm"];
const MAX_INIT_RETRIES = 40;
const RETRY_DELAY_MS = 250;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const MAX_RECONNECT_ATTEMPTS = 7;
const STOP_AFTER_ERROR_DELAY_MS = 1000;

function isCodec(value: unknown): value is Codec {
  return (
    typeof value === "string" &&
    (KNOWN_CODECS as readonly string[]).includes(value)
  );
}

// Global error handlers - use window.showError from receiver.html
window.onerror = (message, source, lineno, colno, error) => {
  const fullError =
    error || new Error(`${message} at ${source}:${lineno}:${colno}`);
  window.showError?.("JavaScript Error", fullError);
  return false;
};
window.onunhandledrejection = (event) => {
  window.showError?.("Unhandled Promise Rejection", event.reason);
};

// Cast context type - extends SDK type with volume methods missing from @types
// Methods are optional as they may not exist on all Cast devices/SDK versions
type CastReceiverContext = ReturnType<
  typeof cast.framework.CastReceiverContext.getInstance
> & {
  // These methods exist in SDK but are missing from @types/chromecast-caf-receiver
  getSystemVolume?(): SystemVolumeData | null;
  setSystemVolumeLevel?(level: number): void;
  setSystemVolumeMuted?(muted: boolean): void;
};
let castContext: CastReceiverContext | null = null;

let player: SendspinPlayer | undefined;

// Get hardware volume from Cast system (0-100 scale)
// Falls back to default if method unavailable on device
function getHardwareVolume(): { volume: number; muted: boolean } {
  if (castContext?.getSystemVolume) {
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
// Silently no-ops if methods unavailable on device
function setHardwareVolume(volume: number, muted: boolean): void {
  if (!castContext) return;

  // Cast API uses 0.0-1.0 for volume level
  if (castContext.setSystemVolumeLevel) {
    castContext.setSystemVolumeLevel(volume / 100);
  }
  if (castContext.setSystemVolumeMuted) {
    castContext.setSystemVolumeMuted(muted);
  }
  console.log("Sendspin: Set hardware volume:", volume, "muted:", muted);
}

// Send status update to sender
function sendStatusToSender(status: {
  state: "connecting" | "connected" | "playing" | "stopped" | "error";
  message?: string;
  sync?: { synced: boolean; offset?: number; error?: number };
  syncInfo?: {
    clockDriftPercent: number;
    syncErrorMs: number;
    resyncCount: number;
  };
  volume?: number;
  muted?: boolean;
}) {
  if (castContext) {
    castContext.sendCustomMessage(CAST_NAMESPACE, undefined, {
      type: "status",
      ...status,
    });
  }
}

// Player ID, name, and codecs provided by the sender (Music Assistant server)
let providedPlayerId: string | null = null;
let providedPlayerName: string | null = null;
let providedCodecs: Codec[] | null = null;

// Track current connection settings (for detecting changes that require reconnect)
let currentServerUrl: string | null = null;
let currentPlayerCodecs: Codec[] | null = null;

// Track status update interval (cleared on reconnect to prevent memory leak)
let statusIntervalId: ReturnType<typeof setInterval> | null = null;

// Track progress update interval for real-time progress bar updates
let progressIntervalId: ReturnType<typeof setInterval> | null = null;

// Reconnect supervisor state
let hadSuccessfulConnection = false;
let lastKnownConnected = false;
let reconnectAttempt = 0;
let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
let isReconnectInProgress = false;
// Monotonic token: only the latest connect attempt may finalize state.
let connectGeneration = 0;

function clearReconnectTimer() {
  if (reconnectTimerId !== null) {
    clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }
}

function clearStatusIntervals() {
  if (statusIntervalId !== null) {
    clearInterval(statusIntervalId);
    statusIntervalId = null;
  }
  if (progressIntervalId !== null) {
    clearInterval(progressIntervalId);
    progressIntervalId = null;
  }
}

function resetReconnectState() {
  isReconnectInProgress = false;
  reconnectAttempt = 0;
  clearReconnectTimer();
}

function getReconnectDelayMs(attempt: number): number {
  const exponential = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(exponential, RECONNECT_MAX_DELAY_MS);
}

function stopCastAppAfterReconnectExhausted() {
  connectGeneration += 1;

  const message = "Reconnect limit reached; stopping cast app.";
  console.error("Sendspin:", message);
  window.setStatus?.(message);
  sendStatusToSender({ state: "error", message });

  clearStatusIntervals();
  resetReconnectState();
  lastKnownConnected = false;
  currentPlayerState = { isPlaying: false };

  if (player) {
    player.disconnect("shutdown");
    player = undefined;
  }

  setTimeout(() => {
    castContext?.stop();
  }, STOP_AFTER_ERROR_DELAY_MS);
}

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

// Update progress bar using player's trackProgress getter
function updateProgressBar(player: SendspinPlayer) {
  if (!currentPlayerState.isPlaying) {
    return;
  }
  const progress = player.trackProgress;
  if (!progress) {
    return;
  }
  window.setProgress?.(progress.positionMs / 1000, progress.durationMs / 1000);
}

// Track current player state for periodic updates
let currentPlayerState: {
  isPlaying: boolean;
} = { isPlaying: false };

// Connect to Sendspin server
async function connectToServer(
  baseUrl: string,
  options: { fromReconnect?: boolean } = {},
): Promise<boolean> {
  // Claim connect ownership for this invocation.
  const generation = ++connectGeneration;

  if (!options.fromReconnect) {
    resetReconnectState();
  }

  // Cleanup existing player and intervals before creating new one
  clearStatusIntervals();
  lastKnownConnected = false;
  currentPlayerState = { isPlaying: false };
  if (player) {
    console.log("Sendspin: Disconnecting existing player before reconnect");
    player.disconnect();
    player = undefined;
  }

  const playerId = getPlayerId();

  console.log("Sendspin: Connecting to", baseUrl, "as", playerId);
  window.setStatus?.("Connecting...");
  sendStatusToSender({
    state: "connecting",
    message: "Connecting to server...",
  });

  // Use provided name or default
  const clientName = providedPlayerName || "Music Assistant Cast Receiver";

  const newPlayer = new SendspinPlayer({
    playerId,
    baseUrl,
    clientName,
    correctionMode: "sync", // Explicit sync mode for multi-device playback
    storage: memoryStorage, // Cast doesn't support localStorage
    syncDelay: 0, // Server sends actual delay via set_static_delay after connection
    bufferCapacity: 1024 * 1024 * 2, // 2MB (GC4A memory constraint)
    // Use codecs from sender config, default to PCM for maximum compatibility
    codecs: providedCodecs ?? DEFAULT_CODECS,
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

      // Update status and playback state
      window.setStatus?.(state.isPlaying ? "Playing" : "Paused");
      window.setPlaybackState?.(state.isPlaying);

      // Update volume display (including muted state)
      window.setVolume?.(hwVol.volume / 100, hwVol.muted);

      // Update now playing UI
      if (state.serverState.metadata) {
        window.setNowPlaying?.(
          toNowPlayingMetadata(state.serverState.metadata),
        );

        // Start progress interval if not running
        if (!progressIntervalId) {
          progressIntervalId = setInterval(() => {
            updateProgressBar(newPlayer);
          }, 200);
        }
      } else {
        window.setNowPlaying?.(null);
        window.setProgress?.(0, 0);
        if (progressIntervalId) {
          clearInterval(progressIntervalId);
          progressIntervalId = null;
        }
      }

      sendPlayerStatus(newPlayer);
      updateDebug(newPlayer);
    },
  });

  try {
    await newPlayer.connect();
    if (generation !== connectGeneration) {
      newPlayer.disconnect("another_server");
      return true;
    }

    console.log("Sendspin: Connected - ready to play");
    window.setStatus?.("Ready to play");
    player = newPlayer;
    hadSuccessfulConnection = true;
    lastKnownConnected = true;
    resetReconnectState();
    sendStatusToSender({ state: "connected", message: "Ready to play" });

    // Track current connection settings for change detection (only on success)
    currentServerUrl = baseUrl;
    currentPlayerCodecs = providedCodecs ?? DEFAULT_CODECS;

    // Periodically send status to sender
    statusIntervalId = setInterval(() => {
      const connectedNow = newPlayer.isConnected;
      if (!connectedNow) {
        if (
          hadSuccessfulConnection &&
          lastKnownConnected &&
          !isReconnectInProgress &&
          currentServerUrl
        ) {
          console.warn("Sendspin: Runtime connection lost, starting reconnect");
          isReconnectInProgress = true;
          clearStatusIntervals();
          currentPlayerState = { isPlaying: false };
          newPlayer.disconnect("restart");
          player = undefined;
          lastKnownConnected = false;
          scheduleReconnect(currentServerUrl);
        }
        return;
      }

      lastKnownConnected = true;
      updateDebug(newPlayer);
      sendPlayerStatus(newPlayer);
    }, 1000);
    return true;
  } catch (error) {
    if (generation !== connectGeneration) {
      return true;
    }

    console.error("Sendspin: Connection failed:", error);
    if (!options.fromReconnect) {
      window.setStatus?.("Connection failed");
      sendStatusToSender({ state: "error", message: "Connection failed" });
    }
    return false;
  }
}

function scheduleReconnect(baseUrl: string) {
  if (!isReconnectInProgress) {
    return;
  }

  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    stopCastAppAfterReconnectExhausted();
    return;
  }

  const attempt = reconnectAttempt + 1;
  reconnectAttempt = attempt;
  const delayMs = getReconnectDelayMs(attempt);
  const delaySeconds = Math.floor(delayMs / 1000);
  const message = `Connection lost. Reconnecting in ${delaySeconds}s (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})...`;

  window.setStatus?.(message);
  sendStatusToSender({ state: "connecting", message });

  reconnectTimerId = setTimeout(async () => {
    reconnectTimerId = null;
    const connected = await connectToServer(baseUrl, { fromReconnect: true });
    if (!connected) {
      scheduleReconnect(baseUrl);
    }
  }, delayMs);
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

let receiverStarted = false;

// Try to initialize Cast Receiver (returns true on success)
function tryInitCastReceiver(): boolean {
  if (receiverStarted) {
    return true;
  }

  // cast is a global from the Cast SDK script - check if loaded
  const castFramework =
    typeof cast !== "undefined" ? cast.framework : undefined;
  const context = castFramework?.CastReceiverContext?.getInstance();
  if (!castFramework || !context) {
    return false;
  }
  receiverStarted = true;

  // Store context for sending messages back to sender
  // Cast to our extended type (SDK has methods missing from @types)
  castContext = context as CastReceiverContext;

  // Handle remote control keys (OK for play/pause, left/right for skip)
  document.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "Enter": // OK button
      case " ": // Space bar (for testing)
        console.log("Sendspin: Play/Pause key pressed");
        if (currentPlayerState.isPlaying) {
          player?.sendCommand("pause", undefined as never);
        } else {
          player?.sendCommand("play", undefined as never);
        }
        break;
      case "ArrowLeft":
        console.log("Sendspin: Previous key pressed");
        player?.sendCommand("previous", undefined as never);
        break;
      case "ArrowRight":
        console.log("Sendspin: Next key pressed");
        player?.sendCommand("next", undefined as never);
        break;
    }
  });

  console.log("Sendspin: Initializing Cast Receiver...");
  window.setStatus?.("Waiting for sender...");

  // Listen for system (hardware) volume changes
  context.addEventListener(
    castFramework.system.EventType.SYSTEM_VOLUME_CHANGED,
    (event) => {
      const volumeData = event.data as SystemVolumeData;
      console.log("Sendspin: System volume changed:", volumeData);
      const hwVol = getHardwareVolume();
      window.setVolume?.(hwVol.volume / 100, hwVol.muted);
      window.setStatus?.(currentPlayerState.isPlaying ? "Playing" : "Paused");
      // Send volume update to sender
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
    },
  );

  // Cast event listeners
  context.addEventListener(castFramework.system.EventType.READY, () => {
    console.log("Sendspin: Cast receiver READY");
  });

  context.addEventListener(
    castFramework.system.EventType.SENDER_CONNECTED,
    () => {
      console.log("Sendspin: Sender connected");
    },
  );

  context.addEventListener(
    castFramework.system.EventType.SENDER_DISCONNECTED,
    () => {
      console.log("Sendspin: Sender disconnected");
      window.setStatus?.("Disconnected");
    },
  );

  context.addEventListener(castFramework.system.EventType.ERROR, (event) => {
    console.error("Sendspin: Cast error:", event);
  });

  // Listen for custom messages with server URL, player ID, name, and codecs
  context.addCustomMessageListener(CAST_NAMESPACE, (event) => {
    console.log("Sendspin: Received message from sender:", event.data);
    if (!event.data) {
      return;
    }

    // type = "config"
    const serverUrl = event.data.serverUrl;
    const playerId = event.data.playerId;
    const playerName = event.data.playerName;
    const codecs = event.data.codecs;

    if (Array.isArray(codecs) && codecs.every(isCodec)) {
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
    // Check if codecs changed on an existing player - requires reconnect
    if (
      player &&
      currentPlayerCodecs &&
      providedCodecs &&
      // Check for actual changes in codecs
      JSON.stringify(providedCodecs) !== JSON.stringify(currentPlayerCodecs)
    ) {
      const targetUrl = serverUrl ?? currentServerUrl;
      if (targetUrl) {
        console.log("Sendspin: Codecs changed, reconnecting...");
        connectToServer(targetUrl);
      }
      return;
    }

    if (serverUrl && serverUrl !== currentServerUrl) {
      connectToServer(serverUrl);
    }
  });

  // Start the Cast receiver with options
  const options = new castFramework.CastReceiverOptions();
  options.disableIdleTimeout = true;
  options.maxInactivity = 3600; // 1 hour max inactivity

  context.start(options);
  console.log("Sendspin: Cast Receiver started");

  return true;
}

function initCastReceiverWithRetry(attempt = 0) {
  if (tryInitCastReceiver()) {
    return;
  }
  if (attempt >= MAX_INIT_RETRIES) {
    console.log("Sendspin: Cast SDK not available");
    window.setStatus?.("Not running in a Cast receiver context");
    return;
  }
  setTimeout(() => initCastReceiverWithRetry(attempt + 1), RETRY_DELAY_MS);
}

initCastReceiverWithRetry();
