// Camera frames for the model: about one JPEG per second, downscaled to 768 px on the long side.

import { bytesToBase64 } from './codec';

const FRAME_INTERVAL_MS = 1000;
const MAX_SIDE = 768;
const JPEG_QUALITY = 0.6;

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/** One downscaled JPEG of the current video frame as base64, or null if the video is not ready. */
export function captureFrame(video: HTMLVideoElement, canvas = document.createElement('canvas')): Promise<string | null> {
  if (video.readyState < 2 || !video.videoWidth) return Promise.resolve(null);
  const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const g = canvas.getContext('2d');
  if (!g) return Promise.resolve(null);
  g.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return resolve(null);
        blob
          .arrayBuffer()
          .then((buf) => resolve(bytesToBase64(new Uint8Array(buf))))
          .catch(() => resolve(null));
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

export function startFrames(video: HTMLVideoElement, onFrame: (base64Jpeg: string) => void): void {
  stopFrames();
  const canvas = document.createElement('canvas');
  timer = setInterval(() => {
    if (busy || document.hidden) return;
    busy = true;
    void captureFrame(video, canvas)
      .then((jpeg) => {
        if (jpeg) onFrame(jpeg);
      })
      .finally(() => {
        busy = false;
      });
  }, FRAME_INTERVAL_MS);
}

export function stopFrames(): void {
  if (timer) clearInterval(timer);
  timer = null;
  busy = false;
}
