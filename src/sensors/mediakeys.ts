// Headset / hardware play-pause button as a talk button (best effort: support varies by phone and browser).
// Browsers only route media keys to a page that is playing media, so a silent looping <audio> keeps the page
// the "active media session". It is only running while the setting is on.

import { toggleTalk } from '../app/talk';
import { useStore } from '../store';

const ACTIONS: MediaSessionAction[] = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'];

let audio: HTMLAudioElement | null = null;

/** One second of 8 kHz mono silence as a WAV data URI. */
function silentWav(): string {
  const samples = 8000;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); // 8-bit
  str(36, 'data');
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128); // 8-bit silence is 128
  let bin = '';
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

function enable(): void {
  if (!('mediaSession' in navigator)) return;
  audio ??= Object.assign(new Audio(silentWav()), { loop: true });
  void audio.play().catch((err) => console.warn('[mediakeys] silent audio blocked', err));
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Wayfinder', artist: 'Press to talk to the guide' });
  for (const action of ACTIONS) {
    try {
      navigator.mediaSession.setActionHandler(action, () => {
        toggleTalk();
        // Keep the silent track "playing" so the next press is routed here too.
        void audio?.play().catch(() => undefined);
      });
    } catch {
      /* action not supported here */
    }
  }
}

function disable(): void {
  audio?.pause();
  if (!('mediaSession' in navigator)) return;
  for (const action of ACTIONS) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
    } catch {
      /* action not supported here */
    }
  }
}

export function startMediaKeys(): void {
  // Keyboards and switch-access devices send the media key as a key event.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'MediaPlayPause' && useStore.getState().settings.headsetButton) {
      e.preventDefault();
      toggleTalk();
    }
  });
  if (useStore.getState().settings.headsetButton) enable();
  useStore.subscribe((s, prev) => {
    if (s.settings.headsetButton === prev.settings.headsetButton) return;
    if (s.settings.headsetButton) enable();
    else disable();
  });
}
