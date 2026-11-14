import { emit } from './bus';

let stop: (() => void) | null = null;

export function startGeolocation(): () => void {
  if (stop) return stop;
  if (!('geolocation' in navigator)) return () => undefined;
  const id = navigator.geolocation.watchPosition(
    (p) => emit('gps', { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy, time: Date.now() }),
    (err) => console.warn('[gps]', err.message),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 },
  );
  stop = () => {
    navigator.geolocation.clearWatch(id);
    stop = null;
  };
  return stop;
}
