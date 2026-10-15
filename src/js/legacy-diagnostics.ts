// Debug-level diagnostics for the legacy build, to tell a device that is short on CPU
// from one whose audio output misbehaves: the audio context's real sample rate (old
// Chromium ignores the requested one) and how late the main thread runs its timers.
import { AudioScheduler } from "@sendspin/sendspin-js";
import { headlessState, readDisplayInfo } from "./legacy-headless";

const LAG_SAMPLE_MS = 250;
const LAG_REPORT_MS = 10_000;

const initAudioContext = AudioScheduler.prototype.initAudioContext;

AudioScheduler.prototype.initAudioContext = function (
  this: AudioScheduler,
): void {
  const hadContext = Boolean((this as any).audioContext);
  initAudioContext.call(this);
  const context: AudioContext | undefined = (this as any).audioContext;
  if (!hadContext && context) {
    console.log(
      `Sendspin legacy: AudioContext ${context.sampleRate} Hz, ` +
        `baseLatency=${(context as any).baseLatency ?? "n/a"}, ` +
        `display=${JSON.stringify(readDisplayInfo())}, ` +
        `screen skipped=${headlessState()}, UA=${navigator.userAgent}`,
    );
  }
};

let expectedAt = Date.now() + LAG_SAMPLE_MS;
let maxLagMs = 0;
let totalLagMs = 0;
let samples = 0;
let reportAt = Date.now() + LAG_REPORT_MS;

setInterval(() => {
  const now = Date.now();
  const lagMs = Math.max(0, now - expectedAt);
  expectedAt = now + LAG_SAMPLE_MS;
  maxLagMs = Math.max(maxLagMs, lagMs);
  totalLagMs += lagMs;
  samples += 1;
  if (now >= reportAt) {
    console.log(
      `Sendspin legacy: timer lag max=${maxLagMs}ms ` +
        `avg=${(totalLagMs / samples).toFixed(1)}ms over ${samples} samples`,
    );
    maxLagMs = 0;
    totalLagMs = 0;
    samples = 0;
    reportAt = now + LAG_REPORT_MS;
  }
}, LAG_SAMPLE_MS);
