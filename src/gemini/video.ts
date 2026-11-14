// Camera frames for the model: about one JPEG per second, downscaled to 768 px on the long side.

import { bytesToBase64 } from './codec';

const FRAME_INTERVAL_MS = 1000;
const MAX_SIDE = 768;
const JPEG_QUALITY = 0.6;

let timer: ReturnType<typeof setInterval> | null = null;
let canvas: HTMLCanvasElement | null = null;
let busy = false;

export function startFrames(video: HTMLVideoElement, onFrame: (base64Jpeg: string) => void): void {
  stopFrames();
  canvas ??= document.createElement('canvas');
  const c = canvas;
  timer = setInterval(() => {
    if (busy || document.hidden || video.readyState < 2 || !video.videoWidth) return;
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    const g = c.getContext('2d');
    if (!g) return;
    g.drawImage(video, 0, 0, c.width, c.height);
    busy = true;
    c.toBlob(
      (blob) => {
        if (!blob) {
          busy = false;
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => onFrame(bytesToBase64(new Uint8Array(buf))))
          .catch(() => undefined)
          .finally(() => {
            busy = false;
          });
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  }, FRAME_INTERVAL_MS);
}

export function stopFrames(): void {
  if (timer) clearInterval(timer);
  timer = null;
  busy = false;
}
