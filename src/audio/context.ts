// One AudioContext for the whole app (ticks, chimes, the guide's voice and the mic worklet).

let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' });
  }
  return ctx;
}

/** Create and resume the context. Call from a user gesture at least once (Start tap). */
export async function ensureAudio(): Promise<AudioContext> {
  const c = audioContext();
  if (c.state !== 'running') await c.resume();
  return c;
}

/** iOS suspends audio when the page is backgrounded or interrupted; resume on the next touch. */
export function keepAudioAlive(): void {
  const resume = () => {
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pointerdown', resume, { passive: true });
}
