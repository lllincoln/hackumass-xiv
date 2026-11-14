// Position fusion: GPS when it is good, pedestrian dead reckoning in between, map constraints on top.
// A 2D Kalman-style filter in ENU meters with a single uncertainty value σ.

import { dist, type Vec2 } from '../geo';
import { buildingAt, nearestWalkway, type BuildingX, type PackIndex } from '../data/pack';
import { projectOnRing } from '../geo';

export const GPS_MAX_ACCURACY_M = 25;
export const STEP_LENGTH_M = 0.7;
export const SIGMA_PER_STEP_M = 0.15;
export const INDOOR_AFTER_MS = 10_000;
const MAP_MATCH_WEIGHT = 0.3;
const MAP_MATCH_MAX_M = 8;
/** A wall crossing this close to a mapped door is accepted as walking through it. */
const ENTRANCE_PASS_M = 6;
const SIGMA_MAX_M = 80;

export type FusionSnapshot = {
  pos: Vec2 | null;
  sigma: number;
  gpsAccuracy: number | null;
  indoors: boolean;
  building: BuildingX | null;
};

export class Fusion {
  pos: Vec2 | null = null;
  sigma = 30;
  gpsAccuracy: number | null = null;
  building: BuildingX | null = null;
  private lastGoodFix = -Infinity;
  private firstBadFix: number | null = null;
  private lastFixWasGood = false;

  constructor(private index: PackIndex) {}

  reset(pos: Vec2, sigma = 3, now = Date.now()): void {
    this.pos = { ...pos };
    this.sigma = sigma;
    this.building = buildingAt(this.index, pos);
    this.lastGoodFix = now;
    this.firstBadFix = null;
  }

  /** One detected footstep along `headingDeg`. */
  step(headingDeg: number): void {
    if (!this.pos) return;
    const h = (headingDeg * Math.PI) / 180;
    const prev = this.pos;
    let next: Vec2 = { x: prev.x + Math.sin(h) * STEP_LENGTH_M, y: prev.y + Math.cos(h) * STEP_LENGTH_M };
    this.sigma = Math.min(SIGMA_MAX_M, this.sigma + SIGMA_PER_STEP_M);

    const wasIn = this.building;
    if (wasIn) {
      const nowIn = buildingAt(this.index, next);
      if (nowIn?.id !== wasIn.id && !this.leftThroughDoor(wasIn, next)) {
        // Walked "through a wall" far from any door: heading drift. Stay inside.
        next = prev;
      }
    } else if (this.lastFixWasGood) {
      // Outdoors on a path: gently pull the estimate onto the nearest walkable way.
      const near = nearestWalkway(this.index, next, MAP_MATCH_MAX_M);
      if (near) {
        next = {
          x: next.x + MAP_MATCH_WEIGHT * (near.point.x - next.x),
          y: next.y + MAP_MATCH_WEIGHT * (near.point.y - next.y),
        };
      }
    }

    this.pos = next;
    this.building = buildingAt(this.index, next);
  }

  private leftThroughDoor(b: BuildingX, outside: Vec2): boolean {
    // Without mapped doors we cannot tell a real exit from drift, so allow it.
    if (b.entrances.length === 0) return true;
    const crossing = projectOnRing(outside, b.outer).point;
    return b.entrances.some((e) => dist(e.pos, crossing) <= ENTRANCE_PASS_M);
  }

  /** A GPS fix at `meas` with reported accuracy (meters). */
  gps(meas: Vec2, accuracy: number, now = Date.now()): void {
    this.gpsAccuracy = accuracy;
    const good = accuracy <= GPS_MAX_ACCURACY_M;
    this.lastFixWasGood = good;

    if (!this.pos) {
      // Any first fix beats no position at all; σ records how rough it is.
      this.pos = { ...meas };
      this.sigma = Math.min(SIGMA_MAX_M, Math.max(accuracy, 3));
      this.building = buildingAt(this.index, meas);
      if (good) this.lastGoodFix = now;
      else this.firstBadFix ??= now;
      return;
    }

    if (!good) {
      this.firstBadFix ??= now;
      return;
    }
    this.lastGoodFix = now;
    this.firstBadFix = null;

    const r = Math.max(accuracy, 2);
    const k = (this.sigma * this.sigma) / (this.sigma * this.sigma + r * r);
    this.pos = { x: this.pos.x + k * (meas.x - this.pos.x), y: this.pos.y + k * (meas.y - this.pos.y) };
    this.sigma = Math.max(1, Math.sqrt((1 - k) * this.sigma * this.sigma));
    this.building = buildingAt(this.index, this.pos);
  }

  /** Indoors = inside a building footprint, or GPS has been poor for more than 10 s. */
  indoors(now = Date.now()): boolean {
    if (this.building) return true;
    return this.firstBadFix !== null && now - this.firstBadFix > INDOOR_AFTER_MS && now - this.lastGoodFix > INDOOR_AFTER_MS;
  }

  snapshot(now = Date.now()): FusionSnapshot {
    return { pos: this.pos, sigma: this.sigma, gpsAccuracy: this.gpsAccuracy, indoors: this.indoors(now), building: this.building };
  }
}
