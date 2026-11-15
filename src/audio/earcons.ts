// Short tones that say "listening" and "done listening" without words (iOS cannot vibrate from the web).

import { audioContext } from './context';

const GAIN = 0.35;

function tone(freq: number, startS: number, durationS: number): void {
  const ctx = audioContext();
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime + startS;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(GAIN, t0 + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS);
  osc.connect(env).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durationS + 0.02);
}

/** Rising pair: the guide is listening. */
export function listenStartTone(): void {
  tone(587, 0, 0.09);
  tone(880, 0.08, 0.14);
  if ('vibrate' in navigator) navigator.vibrate(20);
}

/** Three quick high beeps: hazard ahead. Plays at once, before the spoken warning. */
export function hazardTone(): void {
  tone(1320, 0, 0.08);
  tone(1320, 0.12, 0.08);
  tone(1320, 0.24, 0.12);
  if ('vibrate' in navigator) navigator.vibrate([80, 60, 80, 60, 120]);
}

/** Falling pair: the guide stopped listening. */
export function listenStopTone(): void {
  tone(880, 0, 0.09);
  tone(587, 0.08, 0.14);
  if ('vibrate' in navigator) navigator.vibrate([10, 40, 10]);
}
