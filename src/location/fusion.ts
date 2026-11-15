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

/**
 * How fast uncertainty grows with time (m²/s), by how well the motion is known. Without this the filter grew
 * confident while standing still and then barely followed GPS once the user walked: the dot lagged meters behind.
 */
const PROCESS_STEPPING = 0.3; // footsteps are moving the estimate
const PROCESS_GPS_VELOCITY = 0.5; // the phone's reported speed and course are moving it
const PROCESS_UNKNOWN = 4; // nothing models the motion: up to about 2 m/s either way
/** Steps this recent mean dead reckoning is moving the estimate; GPS velocity is not used on top. */
const STEPS_RECENT_MS = 1500;
/** Reported GPS velocity is trusted for this long after the fix that carried it. */
const VELOCITY_MAX_AGE_MS = 2500;
/** Below this reported speed the user is standing (GPS speed jitters around zero). */
const MIN_SPEED_MPS = 0.4;
const MAX_SPEED_MPS = 3;
/** A fix's horizontal accuracy is a ~68% radius; the per-axis standard deviation is smaller. */
const ACCURACY_TO_SIGMA = 1 / 1.5;

export type GpsMotion = { speed?: number | null; heading?: number | null };

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
  private lastStepAt = -Infinity;
  private lastPredict: number | null = null;
  /** Velocity from the phone's reported speed and course, ENU m/s. */
  private vel: Vec2 | null = null;
  private velTime = -Infinity;

  constructor(private index: PackIndex) {}

  reset(pos: Vec2, sigma = 3, now = Date.now()): void {
    this.pos = { ...pos };
    this.sigma = sigma;
    this.building = buildingAt(this.index, pos);
    this.lastGoodFix = now;
    this.firstBadFix = null;
    this.vel = null;
    this.lastPredict = now;
  }

  /**
   * Advance the estimate to `now`: uncertainty grows with time, and when no footsteps are being detected the
   * phone's reported GPS velocity carries the position forward between fixes. Call often (it is cheap).
   */
  predict(now = Date.now()): void {
    const last = this.lastPredict;
    this.lastPredict = now;
    if (!this.pos || last === null) return;
    const dt = Math.min(2, Math.max(0, (now - last) / 1000));
    if (dt === 0) return;

    const stepping = now - this.lastStepAt < STEPS_RECENT_MS;
    const vel = !stepping && this.vel && now - this.velTime < VELOCITY_MAX_AGE_MS ? this.vel : null;
    const q = stepping ? PROCESS_STEPPING : vel ? PROCESS_GPS_VELOCITY : PROCESS_UNKNOWN;
    this.sigma = Math.min(SIGMA_MAX_M, Math.sqrt(this.sigma * this.sigma + q * dt));

    // Outdoors only: indoor GPS velocity is noise, and it must not walk the estimate through walls.
    if (vel && !this.building) {
      this.pos = { x: this.pos.x + vel.x * dt, y: this.pos.y + vel.y * dt };
      this.building = buildingAt(this.index, this.pos);
    }
  }

  /** One detected footstep along `headingDeg`. */
  step(headingDeg: number, now = Date.now()): void {
    if (!this.pos) return;
    this.predict(now);
    this.lastStepAt = now;
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

  /** A GPS fix at `meas` with reported accuracy (meters), taken at `now`, with the phone's speed and course if known. */
  gps(meas: Vec2, accuracy: number, now = Date.now(), motion: GpsMotion = {}): void {
    this.predict(now);
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
    this.updateVelocity(motion, now);

    const r = Math.max(accuracy * ACCURACY_TO_SIGMA, 2);
    const k = (this.sigma * this.sigma) / (this.sigma * this.sigma + r * r);
    this.pos = { x: this.pos.x + k * (meas.x - this.pos.x), y: this.pos.y + k * (meas.y - this.pos.y) };
    this.sigma = Math.max(1, Math.sqrt((1 - k) * this.sigma * this.sigma));
    this.building = buildingAt(this.index, this.pos);
  }

  private updateVelocity({ speed, heading }: GpsMotion, now: number): void {
    if (speed == null || !Number.isFinite(speed) || speed > MAX_SPEED_MPS) {
      this.vel = null; // not reported (or implausible): fall back to steps and time-based uncertainty
      return;
    }
    if (speed < MIN_SPEED_MPS || heading == null || !Number.isFinite(heading)) {
      this.vel = { x: 0, y: 0 };
    } else {
      const h = (heading * Math.PI) / 180;
      this.vel = { x: Math.sin(h) * speed, y: Math.cos(h) * speed };
    }
    this.velTime = now;
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
