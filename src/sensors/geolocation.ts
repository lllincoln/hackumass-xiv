import { emit } from './bus';

let stop: (() => void) | null = null;

export function startGeolocation(): () => void {
  if (stop) return stop;
  if (!('geolocation' in navigator)) return () => undefined;
  const id = navigator.geolocation.watchPosition(
    (p) =>
      emit('gps', {
        lon: p.coords.longitude,
        lat: p.coords.latitude,
        accuracy: p.coords.accuracy,
        time: p.timestamp,
        speed: p.coords.speed,
        heading: p.coords.heading,
      }),
    (err) => console.warn('[gps]', err.message),
    // maximumAge 0: never a cached fix, which would show where the user was up to a second ago.
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
  );
  stop = () => {
    navigator.geolocation.clearWatch(id);
    stop = null;
  };
  return stop;
}
