// Text labels as canvas textures on sprites. No font files or network needed, so labels work offline.
// Style: a dark rounded pill with white text and a colored dot, matching the app's glass panels.

import * as THREE from 'three';

export type LabelTexture = { texture: THREE.CanvasTexture; aspect: number };

const cache = new Map<string, LabelTexture>();
const MAX_CACHED = 300;
const FONT = '600 42px ui-rounded, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HEIGHT = 76;
const PAD = 26;
const DOT = 9;

/**
 * @param color the dot's color (what kind of thing this is)
 * @param emphasis draw the text in the color too (used for the navigation target)
 */
export function labelTexture(text: string, color = '#ffffff', emphasis = false): LabelTexture {
  const key = `${color}|${emphasis}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.font = FONT;
  const textX = PAD + DOT * 2 + 12;
  const width = Math.ceil(g.measureText(text).width) + textX + PAD;
  canvas.width = width;
  canvas.height = HEIGHT;

  // Dark plate: readable over any part of the scene (white on this is above 12:1).
  g.fillStyle = 'rgba(14, 16, 22, 0.88)';
  g.strokeStyle = emphasis ? color : 'rgba(255, 255, 255, 0.28)';
  g.lineWidth = emphasis ? 3 : 2;
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(2, 2, width - 4, HEIGHT - 4, (HEIGHT - 4) / 2);
  else g.rect(2, 2, width - 4, HEIGHT - 4);
  g.fill();
  g.stroke();

  g.fillStyle = color;
  g.beginPath();
  g.arc(PAD + DOT, HEIGHT / 2, DOT, 0, Math.PI * 2);
  g.fill();

  g.font = FONT;
  g.fillStyle = emphasis ? color : '#ffffff';
  g.textBaseline = 'middle';
  g.fillText(text, textX, HEIGHT / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const entry = { texture, aspect: width / HEIGHT };
  cache.set(key, entry);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value as string;
    cache.get(oldest)?.texture.dispose();
    cache.delete(oldest);
  }
  return entry;
}
