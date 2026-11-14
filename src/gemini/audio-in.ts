// Microphone capture: getUserMedia → AudioWorklet → 16 kHz mono PCM16 chunks (~100 ms each).

import { audioContext } from '../audio/context';
import { media } from '../sensors/media';
import { bytesToBase64 } from './codec';

export const MIC_MIME = 'audio/pcm;rate=16000';

let node: AudioWorkletNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let sink: GainNode | null = null;
let moduleLoaded: Promise<void> | null = null;

export async function startMic(onChunk: (base64Pcm: string) => void): Promise<void> {
  if (node) return;
  const ctx = audioContext();
  const stream = await media.openMic();
  moduleLoaded ??= ctx.audioWorklet.addModule('/worklets/mic-processor.js');
  await moduleLoaded;
  if (node) return; // a second caller won the race

  source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'mic-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(bytesToBase64(new Uint8Array(e.data)));
  // The graph must reach the destination to be pulled; a zero gain keeps the mic out of the speaker.
  sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node).connect(sink).connect(ctx.destination);
}

export function stopMic(): void {
  node?.port.close();
  node?.disconnect();
  source?.disconnect();
  sink?.disconnect();
  node = null;
  source = null;
  sink = null;
}
