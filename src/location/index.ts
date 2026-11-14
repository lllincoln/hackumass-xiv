// Wires the sensor bus into the fusion filter and publishes the estimate to the store.

import { toENU } from '../geo';
import type { PackIndex } from '../data/pack';
import { on } from '../sensors/bus';
import { orientation } from '../sensors/orientation';
import { useStore } from '../store';
import { Fusion } from './fusion';

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
      f.gps(toENU(index.origin, fix.lon, fix.lat), fix.accuracy, fix.time);
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
  // Indoor status depends on elapsed time, so re-evaluate it even when no events arrive.
  const timer = setInterval(() => publish(f), 1000);

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
