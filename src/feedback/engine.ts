// Bearing feedback: ticks that speed up and pan toward the side to turn, silence plus a chime when on course.
// Android also vibrates; iOS has no vibration API, so sound carries it (plus an optional haptic trick).

import { audioContext } from '../audio/context';
import { angleDiff } from '../geo';
import { orientation } from '../sensors/orientation';
import { useStore } from '../store';
import { inDeadband, tickParams } from './logic';

const BASE_GAIN = 0.5;
const DUCKED_GAIN = 0.12;

let timer: ReturnType<typeof setTimeout> | null = null;
let inside = false;
let hapticLabel: HTMLLabelElement | null = null;

function volume(): number {
  return useStore.getState().speaking ? DUCKED_GAIN : BASE_GAIN;
}

function blip(freq: number, pan: number, durationS: number, gain: number, type: OscillatorType = 'square'): void {
  const ctx = audioContext();
  if (ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS);
  osc.connect(env);
  if (typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    env.connect(panner).connect(ctx.destination);
  } else {
    env.connect(ctx.destination);
  }
  osc.start(t0);
  osc.stop(t0 + durationS + 0.02);
}

function chime(): void {
  const g = volume() * 0.7;
  blip(880, 0, 0.18, g, 'sine');
  setTimeout(() => blip(1320, 0, 0.25, g, 'sine'), 90);
  if ('vibrate' in navigator) navigator.vibrate([15, 40, 15]);
}

/** iOS 18+: toggling a `<input type="checkbox" switch>` through its label plays a short system haptic. */
function iosHaptic(): void {
  if (!hapticLabel) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.id = 'wf-haptic';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    hapticLabel = document.createElement('label');
    hapticLabel.htmlFor = input.id;
    hapticLabel.setAttribute('aria-hidden', 'true');
    hapticLabel.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
    hapticLabel.appendChild(input);
    document.body.appendChild(hapticLabel);
  }
  hapticLabel.click();
}

function loop(): void {
  const { nav, settings } = useStore.getState();
  const target = nav?.targetBearing;
  if (target == null || !orientation.has) {
    inside = false;
    timer = setTimeout(loop, 250);
    return;
  }

  const diff = angleDiff(orientation.heading, target);
  if (inDeadband(diff, inside)) {
    if (!inside) chime();
    inside = true;
    timer = setTimeout(loop, 80);
    return;
  }
  inside = false;

  const p = tickParams(diff);
  blip(p.pitchHz, p.pan, 0.045, volume());
  if ('vibrate' in navigator) navigator.vibrate(p.vibrateMs);
  else if (settings.iosHaptic) iosHaptic();
  timer = setTimeout(loop, 1000 / p.rateHz);
}

export function startFeedback(): () => void {
  if (timer === null) loop();
  return stopFeedback;
}

export function stopFeedback(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  inside = false;
}
