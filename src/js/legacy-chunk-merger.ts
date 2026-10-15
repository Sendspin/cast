// sendspin-js plays every decoded chunk as its own Web Audio source node: 40 per second
// for PCM (25 ms chunks), about 10 for FLAC. The old Chromium on legacy Cast firmware
// stutters more the more nodes it plays, so the legacy build merges consecutive chunks
// into buffers of about 400 ms before they reach the scheduler.
import { AudioScheduler, type DecodedAudioChunk } from "@sendspin/sendspin-js";

const MERGED_DURATION_US = 400_000;
// a chunk further than this from where the previous one ended starts a new buffer, so
// the scheduler still sees (and resyncs on) real gaps in the stream
const MAX_GAP_US = 1_000;
// hand over a partly filled buffer when no chunk arrives for this long (stream end)
const IDLE_FLUSH_MS = 50;

interface PendingMerge {
  parts: Float32Array[][];
  frames: number;
  sampleRate: number;
  channels: number;
  generation: number;
  serverTimeUs: number;
  nextServerTimeUs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const pendingMerges = new WeakMap<AudioScheduler, PendingMerge>();
const handleChunk = AudioScheduler.prototype.handleDecodedChunk;
const clearBuffers = AudioScheduler.prototype.clearBuffers;

function takePending(scheduler: AudioScheduler): PendingMerge | undefined {
  const pending = pendingMerges.get(scheduler);
  if (pending) {
    pendingMerges.delete(scheduler);
    if (pending.idleTimer !== null) {
      clearTimeout(pending.idleTimer);
    }
  }
  return pending;
}

function flush(scheduler: AudioScheduler): void {
  const pending = takePending(scheduler);
  if (!pending) {
    return;
  }
  const samples: Float32Array[] = [];
  for (let channel = 0; channel < pending.channels; channel++) {
    const merged = new Float32Array(pending.frames);
    let offset = 0;
    for (const part of pending.parts) {
      merged.set(part[channel], offset);
      offset += part[channel].length;
    }
    samples.push(merged);
  }
  handleChunk.call(scheduler, {
    samples,
    sampleRate: pending.sampleRate,
    serverTimeUs: pending.serverTimeUs,
    generation: pending.generation,
  });
}

AudioScheduler.prototype.handleDecodedChunk = function (
  this: AudioScheduler,
  chunk: DecodedAudioChunk,
): void {
  let pending = pendingMerges.get(this);
  if (
    pending &&
    (chunk.generation !== pending.generation ||
      chunk.sampleRate !== pending.sampleRate ||
      chunk.samples.length !== pending.channels ||
      Math.abs(chunk.serverTimeUs - pending.nextServerTimeUs) > MAX_GAP_US)
  ) {
    flush(this);
    pending = undefined;
  }
  if (!pending) {
    pending = {
      parts: [],
      frames: 0,
      sampleRate: chunk.sampleRate,
      channels: chunk.samples.length,
      generation: chunk.generation,
      serverTimeUs: chunk.serverTimeUs,
      nextServerTimeUs: chunk.serverTimeUs,
      idleTimer: null,
    };
    pendingMerges.set(this, pending);
  }
  const frames = chunk.samples[0].length;
  pending.parts.push(chunk.samples);
  pending.frames += frames;
  pending.nextServerTimeUs =
    chunk.serverTimeUs + (frames * 1_000_000) / chunk.sampleRate;

  if (pending.nextServerTimeUs - pending.serverTimeUs >= MERGED_DURATION_US) {
    flush(this);
    return;
  }
  if (pending.idleTimer !== null) {
    clearTimeout(pending.idleTimer);
  }
  pending.idleTimer = setTimeout(() => flush(this), IDLE_FLUSH_MS);
};

AudioScheduler.prototype.clearBuffers = function (this: AudioScheduler): void {
  takePending(this);
  clearBuffers.call(this);
};
