// Device orientation state shared by the heading filter, bearing feedback and the x-ray camera.
// Kept outside the store because it changes ~60 times a second.

import { angleDiff, norm360 } from '../geo';
import { useStore } from '../store';

const RAD = Math.PI / 180;

export const orientation = {
  /** True once any orientation source (sensor or simulator) has reported. */
  has: false,
  /** Degrees. `alpha` is already corrected so that 0 = device top pointing true-ish north. */
  alpha: 0,
  beta: 90,
  gamma: 0,
  /** screen.orientation.angle, degrees. */
  screen: 0,
  /** Smoothed heading of where the phone points, degrees from north. */
  heading: 0,
};

/**
 * Compass heading of where the phone "looks", from W3C deviceorientation angles (alpha must be absolute).
 * Held upright (camera use) that is the back camera's direction; lying flat it is the top edge's direction.
 * This avoids the 180° flip that `360 − alpha` suffers when the phone tilts past vertical.
 */
export function lookHeading(alphaDeg: number, betaDeg: number, gammaDeg: number, screenDeg = 0): number {
  const a = alphaDeg * RAD;
  const b = betaDeg * RAD;
  const g = gammaDeg * RAD;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);
  // World frame: x east, y north, z up. R = Rz(alpha)·Rx(beta)·Ry(gamma).
  // Back-camera direction = −(third column of R).
  const backE = -(cG * sA * sB + cA * sG);
  const backN = -(sA * sG - cA * cG * sB);
  if (Math.hypot(backE, backN) > 0.5) return norm360(Math.atan2(backE, backN) / RAD);
  // Nearly flat: use the top edge (second column), adjusted for a rotated screen.
  const topE = -cB * sA;
  const topN = cA * cB;
  return norm360(Math.atan2(topE, topN) / RAD + screenDeg);
}

/** Circular low-pass filter: averages unit vectors, so 359° and 1° average to 0°, not 180°. */
export class HeadingFilter {
  private x = 0;
  private y = 0;
  private primed = false;
  constructor(private k = 0.2) {}

  update(deg: number): number {
    const cx = Math.cos(deg * RAD);
    const cy = Math.sin(deg * RAD);
    if (!this.primed) {
      this.x = cx;
      this.y = cy;
      this.primed = true;
    } else {
      this.x += this.k * (cx - this.x);
      this.y += this.k * (cy - this.y);
    }
    return norm360(Math.atan2(this.y, this.x) / RAD);
  }

  reset() {
    this.primed = false;
  }
}

const filter = new HeadingFilter(0.2);
let lastStoreUpdate = 0;

/**
 * Single entry point for orientation samples.
 * @param compass iOS `webkitCompassHeading` when alpha is relative (arbitrary zero); omit when alpha is absolute.
 */
export function feedOrientation(alpha: number, beta: number, gamma: number, compass?: number): void {
  let a = alpha;
  if (compass !== undefined) {
    // iOS: alpha drifts from an arbitrary zero. Slowly learn the yaw offset that makes it agree with the compass.
    const relative = lookHeading(alpha, beta, gamma, orientation.screen);
    const wanted = angleDiff(relative, compass);
    yawOffset = yawPrimed ? norm360(yawOffset + 0.05 * angleDiff(yawOffset, norm360(wanted))) : norm360(wanted);
    yawPrimed = true;
    a = alpha - yawOffset; // raising heading by the offset = lowering alpha
  }
  orientation.has = true;
  orientation.alpha = a;
  orientation.beta = beta;
  orientation.gamma = gamma;
  orientation.heading = filter.update(lookHeading(a, beta, gamma, orientation.screen));

  const now = performance.now();
  if (now - lastStoreUpdate > 66) {
    lastStoreUpdate = now;
    const prev = useStore.getState().heading;
    const next = Math.round(orientation.heading * 2) / 2;
    if (prev !== next) useStore.setState({ heading: next });
  }
}

let yawOffset = 0;
let yawPrimed = false;

export function resetOrientation(): void {
  filter.reset();
  yawPrimed = false;
  yawOffset = 0;
}
