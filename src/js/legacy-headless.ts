// A Cast speaker without a display still lays out and paints the now-playing screen:
// album art, a blurred drop shadow and a progress bar whose width is animated. On legacy
// firmware that keeps the CPU busy enough for playback to stutter, so once the device
// reports it has no display, the screen is hidden and the UI helpers from receiver.html
// stop updating it.
const UI_HELPERS = [
  "setNowPlaying",
  "setProgress",
  "setVolume",
  "setDebug",
  "setStatus",
  "setPlaybackState",
] as const;

interface DisplayInfo {
  systemReady: boolean | null;
  displaySupported: boolean | null;
  canDisplayVideo: boolean | null;
}

let headless: boolean | null = null;

/** What the Cast framework reports about the device's display, as far as it knows. */
export function readDisplayInfo(): DisplayInfo {
  const info: DisplayInfo = {
    systemReady: null,
    displaySupported: null,
    canDisplayVideo: null,
  };
  let context: any;
  try {
    context = (
      window as any
    ).cast?.framework?.CastReceiverContext?.getInstance?.();
  } catch {
    return info;
  }
  try {
    const ready = context?.isSystemReady?.();
    info.systemReady = typeof ready === "boolean" ? ready : null;
  } catch {
    // older framework without isSystemReady
  }
  try {
    const capabilities = context?.getDeviceCapabilities?.();
    if (capabilities && typeof capabilities.display_supported === "boolean") {
      info.displaySupported = capabilities.display_supported;
    }
  } catch {
    // not reported before the system is ready, or not at all on old firmware
  }
  try {
    const canDisplay = context?.canDisplayType?.("video/mp4", "avc1.42E01E");
    info.canDisplayVideo = typeof canDisplay === "boolean" ? canDisplay : null;
  } catch {
    // framework not ready yet
  }
  return info;
}

/** Whether the now-playing screen is skipped: true, false, or null while undecided. */
export function headlessState(): boolean | null {
  return headless;
}

// keep asking until the framework knows: Cast 1.28 never reports display_supported, so
// fall back to whether it can show video, but only once the system is ready
function isHeadless(): boolean {
  if (headless !== null) {
    return headless;
  }
  const info = readDisplayInfo();
  if (info.displaySupported !== null) {
    headless = !info.displaySupported;
  } else if (info.systemReady === true && info.canDisplayVideo !== null) {
    headless = !info.canDisplayVideo;
  }
  if (headless) {
    document.body.style.display = "none";
    console.log(
      `Sendspin legacy: device has no display (${JSON.stringify(info)}), ` +
        "now-playing screen skipped",
    );
  }
  return headless === true;
}

for (const name of UI_HELPERS) {
  const helper = (window as any)[name];
  if (typeof helper !== "function") {
    continue;
  }
  (window as any)[name] = function (this: unknown, ...args: unknown[]) {
    if (isHeadless()) {
      return;
    }
    return helper.apply(this, args);
  };
}
