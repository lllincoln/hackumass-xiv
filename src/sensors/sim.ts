// Simulated sensors for `?sim=1`: a "true" position and heading that drive the same bus the real sensors use.

import { bearingENU, dist, fromENU, toENU, type LonLat, type Vec2 } from '../geo';
import { useStore } from '../store';
import { emit } from './bus';
import { feedOrientation } from './orientation';

export type GpsQuality = 'good' | 'indoor' | 'off';

const STEP_M = 0.7;
const TRACK_KEY = 'wayfinder.sim.track';

type Listener = () => void;

class Simulator {
  /** Ground truth, lon/lat. */
  truth: LonLat | null = null;
  heading = 0;
  /** Phone tilt above the horizon, degrees (0 = held upright). */
  pitch = 0;
  gps: GpsQuality = 'good';
  recording = false;
  replaying = false;
  track: LonLat[] = [];

  private gpsTimer: ReturnType<typeof setInterval> | null = null;
  private orientationTimer: ReturnType<typeof setInterval> | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private changed() {
    for (const l of this.listeners) l();
  }

  start(initial: LonLat): void {
    this.truth ??= initial;
    try {
      this.track = JSON.parse(localStorage.getItem(TRACK_KEY) ?? '[]') as LonLat[];
    } catch {
      this.track = [];
    }
    this.pushOrientation();
    emit('teleport', this.truth);
    this.gpsTimer ??= setInterval(() => this.emitGps(), 1000);
    // Keep feeding orientation so the heading filter settles like it does with a real sensor.
    this.orientationTimer ??= setInterval(() => this.pushOrientation(), 50);
    this.emitGps();
    this.changed();
  }

  stop(): void {
    for (const t of [this.gpsTimer, this.orientationTimer, this.replayTimer]) if (t) clearInterval(t);
    this.gpsTimer = this.orientationTimer = this.replayTimer = null;
    this.replaying = false;
  }

  private origin(): LonLat {
    return useStore.getState().pack?.origin ?? this.truth ?? { lon: 0, lat: 0 };
  }

  private pushOrientation(): void {
    // Portrait phone held upright facing `heading`: alpha = 360 − heading, beta = 90 + pitch.
    feedOrientation(360 - this.heading, 90 + this.pitch, 0);
  }

  private emitGps(): void {
    if (!this.truth || this.gps === 'off') return;
    if (this.gps === 'good') {
      const n = toENU(this.origin(), this.truth.lon, this.truth.lat);
      const p = fromENU(this.origin(), n.x + (Math.random() - 0.5) * 3, n.y + (Math.random() - 0.5) * 3);
      emit('gps', { ...p, accuracy: 6, time: Date.now() });
    } else {
      // Indoors: a poor fix tens of meters off, like a real phone under a roof.
      const n = toENU(this.origin(), this.truth.lon, this.truth.lat);
      const p = fromENU(this.origin(), n.x + (Math.random() - 0.5) * 70, n.y + (Math.random() - 0.5) * 70);
      emit('gps', { ...p, accuracy: 45, time: Date.now() });
    }
  }

  /** Click on the map: jump there and reset the filter. */
  teleport(ll: LonLat): void {
    this.truth = ll;
    if (this.recording) this.track.push(ll);
    emit('teleport', ll);
    this.emitGps();
    this.changed();
  }

  setHeading(deg: number): void {
    this.heading = ((deg % 360) + 360) % 360;
    this.pushOrientation();
    this.changed();
  }

  setPitch(deg: number): void {
    this.pitch = Math.max(-80, Math.min(80, deg));
    this.pushOrientation();
    this.changed();
  }

  setGps(q: GpsQuality): void {
    this.gps = q;
    this.emitGps();
    this.changed();
  }

  /** Walk `n` steps along the current heading: moves the truth and fires step events for dead reckoning. */
  walk(n = 1): void {
    if (!this.truth) return;
    for (let i = 0; i < n; i++) {
      const p = toENU(this.origin(), this.truth.lon, this.truth.lat);
      const h = (this.heading * Math.PI) / 180;
      this.truth = fromENU(this.origin(), p.x + Math.sin(h) * STEP_M, p.y + Math.cos(h) * STEP_M);
      if (this.recording) this.track.push(this.truth);
      emit('step', { time: performance.now() });
    }
    this.changed();
  }

  toggleRecording(): void {
    this.recording = !this.recording;
    if (this.recording) this.track = this.truth ? [this.truth] : [];
    else {
      try {
        localStorage.setItem(TRACK_KEY, JSON.stringify(this.track));
      } catch {
        /* storage full or blocked */
      }
    }
    this.changed();
  }

  /** Replay a polyline at walking pace: the recorded track, or the active route when there is one. */
  replay(points?: Vec2[]): void {
    if (this.replaying) {
      this.stopReplay();
      return;
    }
    const origin = this.origin();
    const path = points ?? this.track.map((ll) => toENU(origin, ll.lon, ll.lat));
    if (path.length < 2) return;
    this.replaying = true;
    this.recording = false;
    let i = 1;
    this.truth = fromENU(origin, path[0].x, path[0].y);
    emit('teleport', this.truth);
    // Two steps a second, like a relaxed walk.
    this.replayTimer = setInterval(() => {
      if (!this.truth) return;
      const here = toENU(origin, this.truth.lon, this.truth.lat);
      while (i < path.length && dist(here, path[i]) < STEP_M) i++;
      if (i >= path.length) {
        this.stopReplay();
        return;
      }
      this.heading = bearingENU(here, path[i]);
      this.pushOrientation();
      this.walk(1);
    }, 500);
    this.changed();
  }

  stopReplay(): void {
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = null;
    this.replaying = false;
    this.changed();
  }
}

export const sim = new Simulator();
