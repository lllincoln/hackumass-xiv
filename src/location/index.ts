// Wires the sensor bus into the fusion filter and publishes the estimate to the store.

import { toENU } from '../geo';
import type { PackIndex } from '../data/pack';
import { on } from '../sensors/bus';
import { orientation } from '../sensors/orientation';
import { useStore } from '../store';
import { Fusion } from './fusion';

/** 10 Hz: smooth enough for the dot to move continuously at walking speed. */
const PREDICT_MS = 100;

let fusion: Fusion | null = null;
let stop: (() => void) | null = null;

function publish(f: Fusion): void {
  const snap = f.snapshot();
  const s = useStore.getState();
  const pos = snap.pos ? { x: Math.round(snap.pos.x * 100) / 100, y: Math.round(snap.pos.y * 100) / 100 } : null;
  const sigma = Math.round(snap.sigma * 10) / 10;
  const buildingId = snap.building?.id ?? null;
  const moved = pos?.x !== s.pos?.x || pos?.y !== s.pos?.y;
  if (moved || sigma !== s.sigma || snap.indoors !== s.indoors || buildingId !== s.buildingId || snap.gpsAccuracy !== s.gpsAccuracy) {
    useStore.setState({
      ...(moved ? { pos } : {}),
      sigma,
      gpsAccuracy: snap.gpsAccuracy === null ? null : Math.round(snap.gpsAccuracy),
      indoors: snap.indoors,
      buildingId,
    });
  }
}

export function startLocation(index: PackIndex): () => void {
  if (stop) return stop;
  const f = new Fusion(index);
  fusion = f;

  const offs = [
    on('gps', (fix) => {
      // Fixes can arrive a moment after they were taken; the filter runs on "now" and moves the fix forward
      // along the reported velocity, so the estimate is where the user is, not where they were.
      const now = Date.now();
      const meas = toENU(index.origin, fix.lon, fix.lat);
      const age = Math.min(2, Math.max(0, (now - fix.time) / 1000));
      if (age > 0 && fix.speed != null && fix.heading != null && Number.isFinite(fix.speed) && Number.isFinite(fix.heading)) {
        const h = (fix.heading * Math.PI) / 180;
        meas.x += Math.sin(h) * fix.speed * age;
        meas.y += Math.cos(h) * fix.speed * age;
      }
      f.gps(meas, fix.accuracy, now, { speed: fix.speed, heading: fix.heading });
      publish(f);
    }),
    on('step', () => {
      if (!orientation.has) return;
      f.step(orientation.heading);
      publish(f);
    }),
    on('teleport', (ll) => {
      f.reset(toENU(index.origin, ll.lon, ll.lat));
      publish(f);
    }),
  ];
  // Between events: carry the estimate forward (GPS velocity) and re-evaluate time-dependent indoor status.
  const timer = setInterval(() => {
    f.predict();
    publish(f);
  }, PREDICT_MS);

  stop = () => {
    offs.forEach((off) => off());
    clearInterval(timer);
    fusion = null;
    stop = null;
  };
  return stop;
}

export function currentFusion(): Fusion | null {
  return fusion;
}
