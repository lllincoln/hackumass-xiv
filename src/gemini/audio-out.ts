// Speaker playback of the model's 24 kHz PCM16 audio: chunks are scheduled back to back,
// and the whole queue can be flushed at once when the user interrupts.

import { audioContext } from '../audio/context';
import { useStore } from '../store';
import { base64ToBytes, pcm16ToFloat32, sampleRateOf } from './codec';

const DEFAULT_RATE = 24000;
/** Small lead so the first chunk does not start in the past. */
const LEAD_S = 0.06;

let nextTime = 0;
const playing = new Set<AudioBufferSourceNode>();
let speakingTimer: ReturnType<typeof setTimeout> | null = null;

function setSpeaking(speaking: boolean): void {
  if (useStore.getState().speaking !== speaking) useStore.setState({ speaking });
}

function scheduleSpeakingEnd(): void {
  if (speakingTimer) clearTimeout(speakingTimer);
  const ctx = audioContext();
  const remainingMs = Math.max(0, (nextTime - ctx.currentTime) * 1000);
  speakingTimer = setTimeout(() => {
    if (playing.size === 0 || audioContext().currentTime >= nextTime) setSpeaking(false);
    else scheduleSpeakingEnd();
  }, remainingMs + 150);
}

export function playChunk(base64Pcm: string, mimeType?: string): void {
  const ctx = audioContext();
  const samples = pcm16ToFloat32(base64ToBytes(base64Pcm));
  if (samples.length === 0) return;
  // The buffer keeps the model's sample rate; the context resamples on playback.
  const buffer = ctx.createBuffer(1, samples.length, sampleRateOf(mimeType, DEFAULT_RATE));
  buffer.getChannelData(0).set(samples);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const startAt = Math.max(nextTime, ctx.currentTime + LEAD_S);
  src.start(startAt);
  nextTime = startAt + buffer.duration;
  playing.add(src);
  src.onended = () => playing.delete(src);

  setSpeaking(true);
  scheduleSpeakingEnd();
}

/** Stop everything queued or playing (the user started talking, or the session dropped). */
export function flushPlayback(): void {
  for (const src of playing) {
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  playing.clear();
  nextTime = 0;
  if (speakingTimer) clearTimeout(speakingTimer);
  speakingTimer = null;
  setSpeaking(false);
}
