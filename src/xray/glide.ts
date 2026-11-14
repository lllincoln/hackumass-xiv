// The position estimate arrives in jumps (a GPS fix a second, 0.7 m per detected step). The x-ray scene
// follows this glided copy instead, so the viewpoint moves like walking rather than hopping.
// One module-level value, advanced once per frame by the camera rig and read by everything at the user's feet.

import { useStore } from '../store';

/** Higher = tighter to the estimate, lower = smoother. About 0.3 s to cover most of a step. */
const GLIDE_RATE = 3.5;
/** A change this large is a teleport (first fix, simulator click): jump instead of flying across campus. */
const TELEPORT_M = 40;

export const shown = { x: 0, y: 0, ready: false };

export function advanceGlide(dt: number): void {
  const pos = useStore.getState().pos;
  if (!pos) return;
  // Also jump after a long gap between frames: the scene was paused (camera view showing) and has catching up to do.
  if (!shown.ready || dt > 0.5 || Math.hypot(pos.x - shown.x, pos.y - shown.y) > TELEPORT_M) {
    shown.x = pos.x;
    shown.y = pos.y;
    shown.ready = true;
    return;
  }
  const k = 1 - Math.exp(-Math.min(dt, 0.1) * GLIDE_RATE);
  shown.x += (pos.x - shown.x) * k;
  shown.y += (pos.y - shown.y) * k;
}
