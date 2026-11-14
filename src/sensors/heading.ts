// Compass heading from the device orientation sensors.
// iOS: `deviceorientation` with webkitCompassHeading (after requestPermission on the Start tap).
// Android: `deviceorientationabsolute`, where alpha is already relative to north.

import { feedOrientation, orientation } from './orientation';

type IOSOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };

let stop: (() => void) | null = null;

function readScreenAngle() {
  const angle = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
  orientation.screen = typeof angle === 'number' ? angle : 0;
}

export function startHeading(): () => void {
  if (stop) return stop;
  readScreenAngle();

  let sawAbsolute = false;

  const onAbsolute = (e: DeviceOrientationEvent) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    sawAbsolute = true;
    feedOrientation(e.alpha, e.beta, e.gamma);
  };

  const onRelative = (e: DeviceOrientationEvent) => {
    if (sawAbsolute || e.alpha == null || e.beta == null || e.gamma == null) return;
    const compass = (e as IOSOrientationEvent).webkitCompassHeading;
    if (typeof compass === 'number' && compass >= 0) feedOrientation(e.alpha, e.beta, e.gamma, compass);
    else if (e.absolute) feedOrientation(e.alpha, e.beta, e.gamma);
    // A relative alpha with no compass cannot give a heading: ignore it.
  };

  window.addEventListener('deviceorientationabsolute', onAbsolute as EventListener);
  window.addEventListener('deviceorientation', onRelative);
  screen.orientation?.addEventListener?.('change', readScreenAngle);
  window.addEventListener('orientationchange', readScreenAngle);

  stop = () => {
    window.removeEventListener('deviceorientationabsolute', onAbsolute as EventListener);
    window.removeEventListener('deviceorientation', onRelative);
    screen.orientation?.removeEventListener?.('change', readScreenAngle);
    window.removeEventListener('orientationchange', readScreenAngle);
    stop = null;
  };
  return stop;
}
