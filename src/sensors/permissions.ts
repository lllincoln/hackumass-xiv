// Everything the Start tap has to unlock, in one gesture chain.
// Order matters on iOS: the orientation/motion prompts must be requested synchronously inside the tap,
// before any await, or Safari rejects them.

import { ensureAudio } from '../audio/context';
import { media } from './media';

export type PermissionKey = 'orientation' | 'motion' | 'audio' | 'microphone' | 'camera' | 'location' | 'wakeLock';
export type PermissionResult = 'granted' | 'denied' | 'unsupported';
export type PermissionReport = Record<PermissionKey, PermissionResult>;

export const PERMISSION_EXPLANATIONS: Record<PermissionKey, string> = {
  orientation: 'Compass: to know which way you are facing.',
  motion: 'Motion: to count steps when GPS does not work indoors.',
  audio: 'Sound: for the voice guide and direction ticks.',
  microphone: 'Microphone: so you can talk to the guide.',
  camera: 'Camera: so the guide can describe what is in front of you.',
  location: 'Location: to find you on the campus map.',
  wakeLock: 'Screen stays on while you navigate.',
};

type PermissionRequester = { requestPermission?: () => Promise<'granted' | 'denied'> };

function requestSensor(ctor: unknown): Promise<PermissionResult> {
  if (!ctor) return Promise.resolve('unsupported');
  const req = (ctor as PermissionRequester).requestPermission;
  // Android and desktop need no prompt.
  if (typeof req !== 'function') return Promise.resolve('granted');
  return req.call(ctor).then(
    (r) => (r === 'granted' ? 'granted' : 'denied'),
    () => 'denied' as const,
  );
}

function requestLocation(): Promise<PermissionResult> {
  if (!('geolocation' in navigator)) return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve('granted'),
      (err) => resolve(err.code === err.PERMISSION_DENIED ? 'denied' : 'granted'),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5_000 },
    );
  });
}

let wakeLock: WakeLockSentinel | null = null;
async function requestWakeLock(): Promise<PermissionResult> {
  if (!('wakeLock' in navigator)) return 'unsupported';
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    return 'granted';
  } catch {
    return 'denied';
  }
}

let wakeLockHooked = false;
function keepWakeLock() {
  if (wakeLockHooked) return;
  wakeLockHooked = true;
  // The lock is released whenever the page is hidden; take it again when the user comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) void requestWakeLock();
  });
}

/**
 * Must be called directly from a click/tap handler.
 * `onProgress` is called as each permission resolves so the Start screen can announce it.
 */
export async function requestAllPermissions(
  onProgress?: (key: PermissionKey, result: PermissionResult) => void,
): Promise<PermissionReport> {
  const note = (key: PermissionKey) => (result: PermissionResult) => {
    onProgress?.(key, result);
    return result;
  };

  // 1. Synchronous part of the gesture: iOS sensor prompts and the audio context.
  const orientationP = requestSensor((window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent).then(note('orientation'));
  const motionP = requestSensor((window as unknown as { DeviceMotionEvent?: unknown }).DeviceMotionEvent).then(note('motion'));
  const audioP = ensureAudio().then(
    () => 'granted' as const,
    () => 'denied' as const,
  ).then(note('audio'));

  const orientation = await orientationP;
  const motion = await motionP;
  const audio = await audioP;

  // 2. Media and location prompts (these may be shown one after another by the browser).
  const microphone = await media.openMic().then(
    () => 'granted' as const,
    () => 'denied' as const,
  ).then(note('microphone'));
  const camera = await media.openCamera().then(
    () => 'granted' as const,
    () => 'denied' as const,
  ).then(note('camera'));
  const location = await requestLocation().then(note('location'));
  const wake = await requestWakeLock().then(note('wakeLock'));
  keepWakeLock();

  return { orientation, motion, audio, microphone, camera, location, wakeLock: wake };
}
