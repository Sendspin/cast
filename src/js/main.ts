import {
  SendspinPlayer,
  ServerStateMetadata,
} from "@music-assistant/sendspin-js";

interface NowPlayingMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
}

declare global {
  interface Window {
    setStatus?: (text: string) => void;
    setDebug?: (text: string) => void;
    setNowPlaying?: (metadata: NowPlayingMetadata | null) => void;
    setVolume?: (level: number) => void;
    setProgress?: (currentSeconds: number, totalSeconds: number) => void;
    cast?: any;
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
  (window as any).showError?.("JavaScript Error", fullError);
  return false;
};
window.onunhandledrejection = (event) => {
  (window as any).showError?.("Unhandled Promise Rejection", event.reason);
};

// Cast context for sending messages back to sender
let castContext: any = null;

// PlayerManager for handling media commands via Cast Play Control APIs
let playerManager: any = null;

let player: SendspinPlayer | undefined;

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

// Player ID, name, sync delay, and codecs provided by the sender (Music Assistant server)
let providedPlayerId: string | null = null;
let providedPlayerName: string | null = null;
let providedSyncDelay: number = 0;
let providedCodecs: Codec[] | null = null;

// Track current connection settings (for detecting changes that require reconnect)
let currentServerUrl: string | null = null;
let currentPlayerCodecs: Codec[] | null = null;

// Track status update interval (cleared on reconnect to prevent memory leak)
let statusIntervalId: ReturnType<typeof setInterval> | null = null;

// Track progress update interval for real-time progress bar updates
let progressIntervalId: ReturnType<typeof setInterval> | null = null;

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

// Update PlayerManager state for Cast media controls (Google Home, etc.)
function updatePlayerManagerState(
  metadata: ServerStateMetadata,
  isPlaying: boolean,
): void {
  if (!playerManager || !window.cast) return;

  const castFw = window.cast.framework;
  const duration = metadata.progress?.track_duration
    ? metadata.progress.track_duration / 1000
    : 0;

  const mediaInfo = {
    contentId: "sendspin-stream",
    contentType: "audio/pcm",
    streamType:
      duration > 0
        ? castFw.messages.StreamType.BUFFERED
        : castFw.messages.StreamType.LIVE,
    duration,
    metadata: {
      metadataType: castFw.messages.MetadataType.MUSIC_TRACK,
      title: metadata.title ?? "Unknown",
      artist: metadata.artist ?? "",
      albumName: metadata.album ?? "",
      images: metadata.artwork_url ? [{ url: metadata.artwork_url }] : [],
    },
  };

  // Set supported commands so Google Home shows play/pause/skip controls
  const supportedCommands =
    castFw.messages.Command.PAUSE |
    castFw.messages.Command.QUEUE_NEXT |
    castFw.messages.Command.QUEUE_PREV;
  playerManager.setSupportedMediaCommands(supportedCommands);

  playerManager.setMediaInformation(mediaInfo, true);
  playerManager.broadcastStatus(true);
}

// Clear PlayerManager state when not playing
function clearPlayerManagerState(): void {
  if (!playerManager) return;
  playerManager.broadcastStatus(true);
}

// Connect to Sendspin server
async function connectToServer(baseUrl: string) {
  // Cleanup existing player and intervals before creating new one
  if (statusIntervalId !== null) {
    clearInterval(statusIntervalId);
    statusIntervalId = null;
  }
  if (progressIntervalId !== null) {
    clearInterval(progressIntervalId);
    progressIntervalId = null;
  }
  if (player) {
    console.log("Sendspin: Disconnecting existing player before reconnect");
    player.disconnect();
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

  console.log("Sendspin: Using sync delay:", providedSyncDelay, "ms");

  const newPlayer = new SendspinPlayer({
    playerId,
    baseUrl,
    clientName,
    correctionMode: "sync", // Explicit sync mode for multi-device playback
    storage: memoryStorage, // Cast doesn't support localStorage
    syncDelay: providedSyncDelay,
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

      // Update status
      if (state.isPlaying) {
        window.setStatus?.("Playing");
      } else {
        window.setStatus?.("Paused");
      }

      // Update volume display
      window.setVolume?.(hwVol.volume / 100);

      // Update now playing UI and Cast PlayerManager
      if (state.serverState.metadata) {
        window.setNowPlaying?.(
          toNowPlayingMetadata(state.serverState.metadata),
        );
        updatePlayerManagerState(state.serverState.metadata, state.isPlaying);

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
        clearPlayerManagerState();
      }

      sendPlayerStatus(newPlayer);
      updateDebug(newPlayer);
    },
  });

  try {
    await newPlayer.connect();
    console.log("Sendspin: Connected - ready to play");
    window.setStatus?.("Ready to play");
    player = newPlayer;
    sendStatusToSender({ state: "connected", message: "Ready to play" });

    // Track current connection settings for change detection (only on success)
    currentServerUrl = baseUrl;
    currentPlayerCodecs = providedCodecs ?? DEFAULT_CODECS;

    // Periodically send status to sender
    statusIntervalId = setInterval(() => {
      updateDebug(newPlayer);
      sendPlayerStatus(newPlayer);
    }, 1000);
  } catch (error) {
    console.error("Sendspin: Connection failed:", error);
    window.setStatus?.("Connection failed");
    sendStatusToSender({ state: "error", message: "Connection failed" });
  }
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

  const castFramework = window.cast?.framework;
  const context = castFramework?.CastReceiverContext?.getInstance();
  if (!castFramework || !context) {
    return false;
  }
  receiverStarted = true;

  // Store context for sending messages back to sender
  castContext = context;

  // Get PlayerManager for handling media commands (Google Home controls)
  playerManager = context.getPlayerManager();

  // Set up message interceptors for media commands
  if (playerManager) {
    // PLAY: Forward to Sendspin server
    playerManager.setMessageInterceptor(
      castFramework.messages.MessageType.PLAY,
      (requestData: any) => {
        console.log("Sendspin: PLAY command received");
        player?.sendCommand("play", undefined as never);
        return requestData;
      },
    );

    // PAUSE: Forward to Sendspin server
    playerManager.setMessageInterceptor(
      castFramework.messages.MessageType.PAUSE,
      (requestData: any) => {
        console.log("Sendspin: PAUSE command received");
        player?.sendCommand("pause", undefined as never);
        return requestData;
      },
    );

    // STOP: Forward as pause
    playerManager.setMessageInterceptor(
      castFramework.messages.MessageType.STOP,
      (requestData: any) => {
        console.log("Sendspin: STOP command received");
        player?.sendCommand("pause", undefined as never);
        return requestData;
      },
    );

    // QUEUE_UPDATE: Handle next/previous (QUEUE_NEXT/QUEUE_PREV map to this)
    playerManager.setMessageInterceptor(
      castFramework.messages.MessageType.QUEUE_UPDATE,
      (requestData: any) => {
        if (requestData.jump === 1) {
          console.log("Sendspin: NEXT command received");
          player?.sendCommand("next", undefined as never);
        } else if (requestData.jump === -1) {
          console.log("Sendspin: PREVIOUS command received");
          player?.sendCommand("previous", undefined as never);
        }
        return requestData;
      },
    );

    // Override playerState in MEDIA_STATUS before it's sent (WebAudio doesn't update this automatically)
    playerManager.setMessageInterceptor(
      castFramework.messages.MessageType.MEDIA_STATUS,
      (status: any) => {
        if (status) {
          status.playerState = currentPlayerState.isPlaying
            ? castFramework.messages.PlayerState.PLAYING
            : castFramework.messages.PlayerState.PAUSED;
        }
        return status;
      },
    );
  }

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
    (event: any) => {
      console.log("Sendspin: System volume changed:", event.data);
      const hwVol = getHardwareVolume();
      window.setVolume?.(hwVol.volume / 100);
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

  context.addEventListener(
    castFramework.system.EventType.ERROR,
    (event: any) => {
      console.error("Sendspin: Cast error:", event);
    },
  );

  // Listen for custom messages with server URL, player ID, name, and sync delay
  context.addCustomMessageListener(CAST_NAMESPACE, (event: any) => {
    console.log("Sendspin: Received message from sender:", event.data);
    if (!event.data) {
      return;
    }

    // type = "config"
    const serverUrl = event.data.serverUrl;
    const playerId = event.data.playerId;
    const playerName = event.data.playerName;
    const syncDelay = event.data.syncDelay;
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
    if (typeof syncDelay === "number") {
      // Store the sync delay provided by Music Assistant
      providedSyncDelay = syncDelay;
      console.log("Sendspin: Using sync delay from sender:", syncDelay, "ms");
      // Update existing player if already connected
      if (player) {
        player.setSyncDelay(syncDelay);
        console.log("Sendspin: Updated sync delay on existing player");
      }
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
