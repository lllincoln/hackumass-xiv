// Live hazard check: every 3-10 s, in either view, send the current camera frame to Gemma (via /api/hazard),
// which answers only T or F. On T, the view switches to the camera (if it was on x-ray) and the guide warns the
// user out loud. On the next F, the view goes back to x-ray.

import { hazardCleared, openCameraForHazard } from '../app/mode';
import { captureFrame } from '../gemini/video';
import { hazardTone } from '../audio/earcons';
import { announce } from '../nav/announce';

const MIN_GAP_MS = 3_000;
const MAX_GAP_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** The same hazard still in view is warned about again only after this long. */
const REPEAT_WARNING_MS = 15_000;

let lastWarning = -Infinity;
/** A clear check came back since the last warning: the next hazard is a new one. */
let clearSinceWarning = true;

let stop: (() => void) | null = null;

function gap(): number {
  return MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
}

async function check(jpeg: string, signal: AbortSignal): Promise<boolean | null> {
  const res = await fetch('/api/hazard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: jpeg }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!res.ok) return null;
  const { hazard } = (await res.json()) as { hazard?: boolean };
  return hazard === true;
}

/** Start checking frames from `video`. Returns a function that stops it. One request at a time. */
export function startHazardWatcher(video: HTMLVideoElement): () => void {
  stop?.();
  const ctrl = new AbortController();
  const canvas = document.createElement('canvas');
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    timer = null;
    try {
      if (!document.hidden) {
        const jpeg = await captureFrame(video, canvas);
        const hazard = jpeg && !ctrl.signal.aborted ? await check(jpeg, ctrl.signal) : null;
        if (ctrl.signal.aborted || hazard === null) {
          // no frame or a failed check: change nothing
        } else if (!hazard) {
          clearSinceWarning = true;
          hazardCleared();
        } else {
          // Switch first, so the guide is already looking when it gets the warning.
          openCameraForHazard();
          // Warn once per hazard: again only after the path was clear in between, or after a while.
          const now = Date.now();
          if (clearSinceWarning || now - lastWarning > REPEAT_WARNING_MS) {
            lastWarning = now;
            clearSinceWarning = false;
            hazardTone();
            announce('Stop. Possible hazard directly ahead.', 'Heads up', {
              key: 'hazard',
              // Safety first: this one cuts the guide off instead of waiting for its turn to end.
              urgent: true,
              agentOnly: '(From the camera hazard check. If you can see it, say briefly what it is and where, using clock positions.)',
            });
          }
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) console.warn('[hazard] check failed', err);
    }
    if (!ctrl.signal.aborted) timer = setTimeout(() => void tick(), gap());
  };
  timer = setTimeout(() => void tick(), gap());

  const s = () => {
    ctrl.abort();
    if (timer) clearTimeout(timer);
    if (stop === s) stop = null;
  };
  stop = s;
  return s;
}
