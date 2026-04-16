import { SendspinPlayer, ServerStateMetadata } from "@sendspin/sendspin-js";
import errorAudioUrl from "../assets/error-incompatible.mp3";

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
    cast?: any;
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

const KNOWN_CODECS = ["flac", "pcm", "opus"] as const;
type Codec = (typeof KNOWN_CODECS)[number];
const DEFAULT_CODECS: Codec[] = ["pcm"];
const MAX_INIT_RETRIES = 40;
const RETRY_DELAY_MS = 250;
const STOP_AFTER_ERROR_DELAY_MS = 1000;
// Give up after ~60s (1s, 2s, 4s, 8s, 15s, 15s, 15s).
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const RECONNECT_MAX_ATTEMPTS = 7;

function isCodec(value: unknown): value is Codec {
  return (
    typeof value === "string" &&
    (KNOWN_CODECS as readonly string[]).includes(value)
  );
}

/** Build a full codec list with preferred codecs first, remaining known codecs after.
 *  Opus is only included when explicitly requested by the sender. */
function buildCodecList(preferred: Codec[]): Codec[] {
  const rest = KNOWN_CODECS.filter(
    (c) => c !== "opus" && !preferred.includes(c),
  );
  return [...preferred, ...rest];
}

// Unified wrapper so CAF and legacy receiver paths expose the same API.
interface CastContextWrapper {
  getSystemVolume(): SystemVolumeData | null;
  setSystemVolumeLevel(level: number): void;
  setSystemVolumeMuted(muted: boolean): void;
  sendCustomMessage(
    namespace: string,
    senderId: string | undefined,
    data: unknown,
  ): void;
  stop(): void;
}
let castContext: CastContextWrapper | null = null;
let hasSenderConnected = false;

const LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
type LogLevel = keyof typeof LOG_LEVELS;
let receiverLogLevel: LogLevel = "off";

type ReceiverLogPayload = {
  type: "receiver_log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
  /* Below fields are only present for "error" events */
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
};

let globalErrorForwardingInitialized = false;

function sendReceiverLog(log: Omit<ReceiverLogPayload, "type" | "timestamp">) {
  if (
    receiverLogLevel === "off" ||
    LOG_LEVELS[log.level] > LOG_LEVELS[receiverLogLevel] ||
    !castContext ||
    !hasSenderConnected
  ) {
    return;
  }

  const payload: ReceiverLogPayload = {
    type: "receiver_log",
    timestamp: new Date().toISOString(),
    ...log,
  };

  try {
    castContext.sendCustomMessage(CAST_NAMESPACE, undefined, payload);
  } catch {
    // Drop silently to avoid recursion
  }
}

function setupGlobalErrorForwarding() {
  if (globalErrorForwardingInitialized) {
    return;
  }
  globalErrorForwardingInitialized = true;

  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function stringifyConsoleArg(arg: unknown): string {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }

  function forwardConsole(
    level: ReceiverLogPayload["level"],
    args: unknown[],
  ): void {
    const message =
      args.length > 0
        ? args.map((arg) => stringifyConsoleArg(arg)).join(" ")
        : "(empty log)";
    const firstError = args.find((arg): arg is Error => arg instanceof Error);
    sendReceiverLog({
      level,
      message,
      stack: firstError?.stack,
    });
  }

  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    forwardConsole("debug", args);
  };
  console.info = (...args: unknown[]) => {
    originalConsole.info(...args);
    forwardConsole("info", args);
  };
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    forwardConsole("warn", args);
  };
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    forwardConsole("error", args);
  };

  window.addEventListener("error", (event) => {
    const runtimeError = event.error;
    sendReceiverLog({
      level: "error",
      message:
        event.message ||
        (runtimeError instanceof Error
          ? runtimeError.message
          : "Unknown error"),
      stack: runtimeError instanceof Error ? runtimeError.stack : undefined,
      source: event.filename ?? undefined,
      line: event.lineno ?? undefined,
      column: event.colno ?? undefined,
    });
  });
}

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

// Player ID, name, codecs, and sync delay provided by the sender
let providedPlayerId: string | null = null;
let providedPlayerName: string | null = null;
let providedCodecs: Codec[] | null = null;
let providedSyncDelay: number = 0;

// Track current connection settings (for detecting changes that require reconnect)
let currentServerUrl: string | null = null;
let currentPlayerCodecs: Codec[] | null = null;

// Track status update interval (cleared on reconnect to prevent memory leak)
let statusIntervalId: ReturnType<typeof setInterval> | null = null;

// Track progress update interval for real-time progress bar updates
let progressIntervalId: ReturnType<typeof setInterval> | null = null;

// Monotonic token: only the latest connect attempt may finalize state.
let connectGeneration = 0;
let fatalShutdownInitiated = false;

// Track current player state for periodic updates
let currentPlayerState: {
  isPlaying: boolean;
} = { isPlaying: false };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
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

function handleFatalError(
  context: string,
  error: unknown,
  summary = "Receiver encountered a fatal error.",
) {
  if (fatalShutdownInitiated) {
    return;
  }
  fatalShutdownInitiated = true;
  connectGeneration += 1;

  const cause = toErrorMessage(error);
  const message = `${summary} Cause: ${cause}`;
  console.error(`Sendspin: Fatal [${context}]:`, error);
  window.setStatus?.(message);
  sendStatusToSender({ state: "error", message });
  const normalizedError = error instanceof Error ? error : new Error(cause);
  window.showError?.(context, normalizedError);

  clearStatusIntervals();
  currentPlayerState = { isPlaying: false };

  if (player) {
    player.disconnect("shutdown");
    player = undefined;
  }

  setTimeout(() => {
    castContext?.stop();
  }, STOP_AFTER_ERROR_DELAY_MS);
}

async function ensureAudioContextSupported(): Promise<boolean> {
  if (typeof AudioContext !== "undefined") {
    return true;
  }

  // Play TTS error message via <audio> element (works without AudioContext).
  try {
    const audio = new Audio(errorAudioUrl);
    const playbackDone = new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      setTimeout(resolve, 15000); // safety timeout
    });
    await audio.play();
    await playbackDone;
  } catch {
    // Audio playback failed — proceed with fatal error anyway.
  }

  handleFatalError(
    "Audio Setup",
    new Error("AudioContext is not implemented on this device"),
    "Audio output is not supported on this Cast device.",
  );
  return false;
}

// Global error handlers route unexpected failures through fatal shutdown path.
window.onerror = (message, source, lineno, colno, error) => {
  const fullError =
    error || new Error(`${message} at ${source}:${lineno}:${colno}`);
  handleFatalError(
    "JavaScript Error",
    fullError,
    "Receiver encountered a fatal runtime error.",
  );
  return false;
};

window.onunhandledrejection = (event) => {
  handleFatalError(
    "Unhandled Promise Rejection",
    event.reason,
    "Receiver encountered a fatal runtime error.",
  );
  event.preventDefault();
};

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

// Connect to Sendspin server
async function connectToServer(baseUrl: string): Promise<boolean> {
  // Claim connect ownership for this invocation.
  const generation = ++connectGeneration;

  // Cleanup existing player and intervals before creating new one
  clearStatusIntervals();
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

  console.log("Sendspin: Using sync delay:", providedSyncDelay, "ms");

  if (!(await ensureAudioContextSupported())) {
    return false;
  }

  let newPlayer: SendspinPlayer;
  try {
    newPlayer = new SendspinPlayer({
      playerId,
      baseUrl,
      clientName,
      correctionMode: "sync", // Explicit sync mode for multi-device playback
      storage: memoryStorage, // Cast doesn't support localStorage
      syncDelay: providedSyncDelay,
      bufferCapacity: 1024 * 1024 * 2, // 2MB (GC4A memory constraint)
      // Use codecs from sender config, default to PCM for maximum compatibility.
      // Advertise all known codecs but with the preferred one(s) first.
      codecs: buildCodecList(providedCodecs ?? DEFAULT_CODECS),
      // Use hardware volume control (Cast system volume)
      useHardwareVolume: true,
      onVolumeCommand: setHardwareVolume,
      onDelayCommand: (delayMs: number) => {
        providedSyncDelay = delayMs;
        if (castContext) {
          castContext.sendCustomMessage(CAST_NAMESPACE, undefined, {
            type: "config",
            syncDelay: delayMs,
          });
        }
      },
      getExternalVolume: getHardwareVolume,
      useOutputLatencyCompensation: true,
      reconnect: {
        baseDelayMs: RECONNECT_BASE_DELAY_MS,
        maxDelayMs: RECONNECT_MAX_DELAY_MS,
        maxAttempts: RECONNECT_MAX_ATTEMPTS,
        onReconnecting: (attempt) => {
          if (generation !== connectGeneration) {
            return;
          }
          const message = `Reconnecting (attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS})...`;
          currentPlayerState = { isPlaying: false };
          // Clear stale UI; library won't fire onStateChange while disconnected.
          window.setStatus?.(message);
          window.setPlaybackState?.(false);
          window.setNowPlaying?.(null);
          window.setProgress?.(0, 0);
          if (progressIntervalId) {
            clearInterval(progressIntervalId);
            progressIntervalId = null;
          }
          sendStatusToSender({ state: "connecting", message });
        },
        onReconnected: () => {
          if (generation !== connectGeneration) {
            return;
          }
          console.log("Sendspin: Reconnected");
          window.setStatus?.("Ready to play");
          sendStatusToSender({ state: "connected", message: "Ready to play" });
        },
        onExhausted: () => {
          if (generation !== connectGeneration) {
            return;
          }
          handleFatalError(
            "Reconnect Exhausted",
            new Error(
              `Reconnect limit reached (${RECONNECT_MAX_ATTEMPTS} attempts)`,
            ),
            "Reconnect limit reached; stopping cast app.",
          );
        },
      },
      onStateChange: (state) => {
        if (generation !== connectGeneration) {
          return;
        }
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
            }, 1000);
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
  } catch (error) {
    handleFatalError(
      "Player Setup",
      error,
      "Failed to initialize the audio player on this device.",
    );
    return false;
  }

  try {
    await newPlayer.connect();
    if (generation !== connectGeneration) {
      newPlayer.disconnect("another_server");
      return true;
    }

    console.log("Sendspin: Connected - ready to play");
    window.setStatus?.("Ready to play");
    player = newPlayer;
    sendStatusToSender({ state: "connected", message: "Ready to play" });

    // Track current connection settings for change detection (only on success)
    currentServerUrl = baseUrl;
    currentPlayerCodecs = providedCodecs ?? DEFAULT_CODECS;

    // Push debug/status while connected; library callbacks own reconnect UI.
    statusIntervalId = setInterval(() => {
      if (generation !== connectGeneration || player !== newPlayer) {
        return;
      }
      if (!newPlayer.isConnected) {
        return;
      }
      updateDebug(newPlayer);
      sendPlayerStatus(newPlayer);
    }, 1000);
    return true;
  } catch (error) {
    if (generation !== connectGeneration) {
      return true;
    }

    console.error("Sendspin: Connection failed:", error);
    window.setStatus?.("Connection failed");
    sendStatusToSender({ state: "error", message: "Connection failed" });
    return false;
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
let preferLegacyAfterCafFailure = false;
let loadedCafVersion: "caf-v3" | "caf-v2" | null = null;

type LoadedCastSdk = "caf-v3" | "caf-v2" | "legacy";

const scriptCache = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const cached = scriptCache.get(src);
  if (cached) return cached;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptCache.delete(src);
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(script);
  });
  scriptCache.set(src, promise);
  return promise;
}

async function ensureCastSdkLoaded(): Promise<LoadedCastSdk | null> {
  if (
    !preferLegacyAfterCafFailure &&
    window.cast?.framework?.CastReceiverContext
  ) {
    return loadedCafVersion ?? "caf-v3";
  }
  if (window.cast?.receiver?.CastReceiverManager) {
    return "legacy";
  }

  if (!preferLegacyAfterCafFailure) {
    try {
      await loadScript(
        "//www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js",
      );
      if (window.cast?.framework?.CastReceiverContext) {
        loadedCafVersion = "caf-v3";
        return "caf-v3";
      }
    } catch (error) {
      console.warn("Sendspin: CAF v3 load failed, trying CAF v2", error);
    }

    try {
      await loadScript(
        "//www.gstatic.com/cast/sdk/libs/caf_receiver/v2/cast_receiver_framework.js",
      );
      if (window.cast?.framework?.CastReceiverContext) {
        loadedCafVersion = "caf-v2";
        return "caf-v2";
      }
    } catch (error) {
      console.warn(
        "Sendspin: CAF v2 load failed, trying legacy receiver API",
        error,
      );
    }
  }

  try {
    await loadScript(
      "//www.gstatic.com/cast/sdk/libs/receiver/2.0.0/cast_receiver.js",
    );
    if (window.cast?.receiver?.CastReceiverManager) {
      return "legacy";
    }
  } catch (error) {
    console.warn("Sendspin: Legacy Cast Receiver API load failed", error);
  }

  return null;
}

function handleSenderMessage(rawMessage: unknown) {
  if (!rawMessage) {
    return;
  }
  let message = rawMessage;
  if (typeof message === "string") {
    try {
      message = JSON.parse(message);
    } catch {
      return;
    }
  }
  console.log("Sendspin: Received message from sender:", message);

  const data = message as Record<string, unknown>;
  const serverUrl =
    typeof data.serverUrl === "string" ? data.serverUrl : undefined;
  const playerId =
    typeof data.playerId === "string" ? data.playerId : undefined;
  const playerName =
    typeof data.playerName === "string" ? data.playerName : undefined;
  const syncDelay =
    typeof data.syncDelay === "number" ? data.syncDelay : undefined;
  const codecs = data.codecs;

  if (
    typeof data.receiverLogLevel === "string" &&
    data.receiverLogLevel in LOG_LEVELS
  ) {
    receiverLogLevel = data.receiverLogLevel as LogLevel;
    if (receiverLogLevel !== "off") {
      setupGlobalErrorForwarding();
    }
  }

  if (Array.isArray(codecs)) {
    const filteredCodecs = codecs.filter(isCodec);
    if (filteredCodecs.length > 0) {
      providedCodecs = filteredCodecs;
      console.log("Sendspin: Using codecs from sender:", filteredCodecs);
    }
  }
  if (playerId) {
    providedPlayerId = playerId;
    console.log("Sendspin: Using player ID from sender:", playerId);
  }
  if (playerName) {
    providedPlayerName = playerName;
    console.log("Sendspin: Using player name from sender:", playerName);
  }
  if (syncDelay !== undefined) {
    providedSyncDelay = syncDelay;
    console.log("Sendspin: Using sync delay from sender:", syncDelay, "ms");
    if (player) {
      player.setSyncDelay(syncDelay);
      console.log("Sendspin: Updated sync delay on existing player");
    }
  }

  if (
    player &&
    currentPlayerCodecs &&
    providedCodecs &&
    JSON.stringify(buildCodecList(providedCodecs)) !==
      JSON.stringify(buildCodecList(currentPlayerCodecs))
  ) {
    const targetUrl = serverUrl ?? currentServerUrl;
    if (targetUrl) {
      console.log("Sendspin: Codecs changed, reconnecting...");
      void connectToServer(targetUrl);
    }
    return;
  }

  if (serverUrl && serverUrl !== currentServerUrl) {
    void connectToServer(serverUrl);
  }
}

let keydownListenerAdded = false;

function installKeydownHandler() {
  if (keydownListenerAdded) return;
  keydownListenerAdded = true;
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
}

// Try to initialize CAF receiver APIs first.
function tryInitCafReceiver(): boolean {
  if (receiverStarted) {
    return true;
  }

  const context = window.cast?.framework?.CastReceiverContext?.getInstance?.();
  if (!context) {
    return false;
  }
  receiverStarted = true;

  castContext = {
    getSystemVolume: () => (context as any).getSystemVolume?.() ?? null,
    setSystemVolumeLevel: (level: number) =>
      (context as any).setSystemVolumeLevel?.(level),
    setSystemVolumeMuted: (muted: boolean) =>
      (context as any).setSystemVolumeMuted?.(muted),
    sendCustomMessage: (
      namespace: string,
      senderId: string | undefined,
      data: unknown,
    ) => {
      context.sendCustomMessage(namespace, senderId, data);
    },
    stop: () => (context as any).stop?.(),
  };

  installKeydownHandler();

  console.log("Sendspin: Initializing CAF receiver...");
  window.setStatus?.("Waiting for sender...");

  const eventType = window.cast?.framework?.system?.EventType;
  context.addEventListener(eventType?.READY ?? "READY", () => {
    console.log("Sendspin: Cast receiver READY");
  });
  context.addEventListener(
    eventType?.SENDER_CONNECTED ?? "SENDER_CONNECTED",
    () => {
      console.log("Sendspin: Sender connected");
      hasSenderConnected = true;
    },
  );
  context.addEventListener(
    eventType?.SENDER_DISCONNECTED ?? "SENDER_DISCONNECTED",
    () => {
      console.log("Sendspin: Sender disconnected");
      window.setStatus?.("Disconnected");
      hasSenderConnected = false;
    },
  );
  context.addEventListener(eventType?.ERROR ?? "ERROR", (event: any) => {
    handleFatalError(
      "Cast Framework Error",
      event,
      "Cast receiver reported a fatal framework error.",
    );
  });
  context.addEventListener(
    eventType?.SYSTEM_VOLUME_CHANGED ?? "SYSTEM_VOLUME_CHANGED",
    (event: any) => {
      console.log("Sendspin: System volume changed:", event?.data);
      const hwVol = getHardwareVolume();
      window.setVolume?.(hwVol.volume / 100, hwVol.muted);
      window.setStatus?.(currentPlayerState.isPlaying ? "Playing" : "Paused");
      if (player) {
        sendPlayerStatus(player);
      } else {
        sendStatusToSender({
          state: "connected",
          volume: hwVol.volume,
          muted: hwVol.muted,
        });
      }
    },
  );

  context.addCustomMessageListener(CAST_NAMESPACE, (event: any) => {
    hasSenderConnected = true;
    handleSenderMessage(event?.data);
  });

  const startOptions: Record<string, unknown> = {
    statusText: "Ready to play",
    disableIdleTimeout: true,
    maxInactivity: 3600,
  };
  const messageType = window.cast?.framework?.system?.MessageType?.JSON;
  if (messageType) {
    startOptions.customNamespaces = {
      [CAST_NAMESPACE]: messageType,
    };
  }
  try {
    context.start(startOptions);
  } catch (error) {
    console.error("Sendspin: CAF receiver start failed, falling back", error);
    castContext = null;
    receiverStarted = false;
    preferLegacyAfterCafFailure = true;
    return false;
  }
  console.log("Sendspin: CAF Receiver started");

  return true;
}

// Try to initialize legacy Cast Receiver API (fallback)
function tryInitLegacyReceiver(): boolean {
  if (receiverStarted) {
    return true;
  }

  const receiverApi = window.cast?.receiver;
  const manager = receiverApi?.CastReceiverManager?.getInstance?.();
  const messageBus = manager?.getCastMessageBus?.(CAST_NAMESPACE);
  if (!receiverApi || !manager || !messageBus) {
    return false;
  }
  receiverStarted = true;

  castContext = {
    getSystemVolume: () => (manager as any).getSystemVolume?.() ?? null,
    setSystemVolumeLevel: (level: number) =>
      (manager as any).setSystemVolumeLevel?.(level),
    setSystemVolumeMuted: (muted: boolean) =>
      (manager as any).setSystemVolumeMuted?.(muted),
    sendCustomMessage: (
      _namespace: string,
      _senderId: string | undefined,
      data: unknown,
    ) => {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      messageBus.broadcast(payload);
    },
    stop: () => (manager as any).stop?.(),
  };
  installKeydownHandler();
  console.log("Sendspin: Initializing legacy Cast Receiver...");
  window.setStatus?.("Waiting for sender...");

  manager.onReady = () => {
    console.log("Sendspin: Cast receiver READY");
  };

  manager.onSenderConnected = () => {
    console.log("Sendspin: Sender connected");
    hasSenderConnected = true;
  };

  manager.onSenderDisconnected = () => {
    console.log("Sendspin: Sender disconnected");
    window.setStatus?.("Disconnected");
    hasSenderConnected = false;
  };

  manager.onError = (event: any) => {
    handleFatalError(
      "Cast Framework Error",
      event,
      "Cast receiver reported a fatal framework error.",
    );
  };

  manager.onSystemVolumeChanged = (event: any) => {
    console.log("Sendspin: System volume changed:", event);
    const hwVol = getHardwareVolume();
    window.setVolume?.(hwVol.volume / 100, hwVol.muted);
    window.setStatus?.(currentPlayerState.isPlaying ? "Playing" : "Paused");
    if (player) {
      sendPlayerStatus(player);
    } else {
      sendStatusToSender({
        state: "connected",
        volume: hwVol.volume,
        muted: hwVol.muted,
      });
    }
  };

  messageBus.onMessage = (event: any) => {
    hasSenderConnected = true;
    handleSenderMessage(event?.data);
  };

  manager.start({
    statusText: "Ready to play",
    maxInactivity: 3600,
  });
  console.log("Sendspin: Legacy Cast Receiver started");

  return true;
}

async function initCastReceiver() {
  for (let attempt = 0; attempt < MAX_INIT_RETRIES; attempt += 1) {
    const sdk = await ensureCastSdkLoaded();
    const started =
      sdk === "legacy"
        ? tryInitLegacyReceiver()
        : sdk && (tryInitCafReceiver() || tryInitLegacyReceiver());
    if (started) {
      console.log(`Sendspin: Using ${sdk} Cast receiver SDK`);
      return;
    }

    if (attempt < MAX_INIT_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  console.log("Sendspin: Cast SDK not available");
  window.setStatus?.("Not running in a Cast receiver context");
}

void initCastReceiver();
