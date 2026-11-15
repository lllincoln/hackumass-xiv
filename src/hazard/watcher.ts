// Live hazard check: every 2 s, in either view, send the current camera frame to /api/hazard (Gemini Decisions API,
// well under a second): is something about to be in the user's way, what is it, and on which side. On yes, the view
// switches to the camera (if it was on x-ray) and the guide says what it is and what to do ("Crosswalk straight ahead.
// Stop at the curb, listen, and cross straight when you don't hear any cars."). On the next no, back to x-ray.

import { hazardCleared, openCameraForHazard } from '../app/mode';
import { captureFrame } from '../gemini/video';
import { hazardTone } from '../audio/earcons';
import { live } from '../gemini/session';
import { announce } from '../nav/announce';
import { hazardAdvice, type HazardKind, type HazardResult } from '../../shared/hazards';

/** Time from one check's answer to the next frame (each check takes well under a second). */
const GAP_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** The same hazard still in view is warned about again only after this long. */
const REPEAT_WARNING_MS = 15_000;

let lastWarning = -Infinity;
let lastKind: HazardKind | undefined;
/** A clear check came back since the last warning: the next hazard is a new one. */
let clearSinceWarning = true;

let stop: (() => void) | null = null;

function gap(): number {
  return GAP_MS;
}

async function check(jpeg: string, signal: AbortSignal): Promise<HazardResult | null> {
  const res = await fetch('/api/hazard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: jpeg }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!res.ok) return null;
  const result = (await res.json()) as Partial<HazardResult>;
  return typeof result.hazard === 'boolean' ? (result as HazardResult) : null;
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
        const result = jpeg && !ctrl.signal.aborted ? await check(jpeg, ctrl.signal) : null;
        if (ctrl.signal.aborted || !jpeg || result === null) {
          // no frame or a failed check: change nothing
        } else if (!result.hazard) {
          clearSinceWarning = true;
          hazardCleared();
        } else {
          // Switch first, so the guide is already looking when it gets the warning.
          openCameraForHazard();
          // Warn once per hazard: again only after the path was clear in between, when it is something else,
          // or after a while.
          const now = Date.now();
          if (clearSinceWarning || result.kind !== lastKind || now - lastWarning > REPEAT_WARNING_MS) {
            lastWarning = now;
            lastKind = result.kind;
            clearSinceWarning = false;
            hazardTone();
            // The guide gets the frame that triggered this, so it can confirm or add detail from what it sees.
            live.sendVideo(jpeg);
            announce(hazardAdvice(result.kind, result.side), 'Heads up', {
              key: 'hazard',
              // Safety first: this one cuts the guide off instead of waiting for its turn to end.
              urgent: true,
              agentOnly:
                '(From the camera hazard check; you have just been sent that frame. Say what it is and what to do, in a ' +
                'sentence or two. If the frame clearly shows something different, describe that instead. Use left, right, ' +
                'straight ahead and behind, never compass directions.)',
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
