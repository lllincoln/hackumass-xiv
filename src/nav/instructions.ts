// OSRM returns maneuver types, not sentences. osrm-text-instructions turns them into English.

import osrmTextInstructions from 'osrm-text-instructions';
import type { OsrmStep } from './osrm';

let compiler: ReturnType<typeof osrmTextInstructions> | null = null;

function fallback(step: OsrmStep): string {
  const { type, modifier } = step.maneuver;
  const onto = step.name ? ` onto ${step.name}` : '';
  if (type === 'depart') return `Head ${modifier ?? 'out'}${step.name ? ` on ${step.name}` : ''}`;
  if (type === 'arrive') return 'You have arrived at your destination';
  if (modifier === 'straight' || !modifier) return `Continue${onto}`;
  if (modifier === 'uturn') return 'Make a U-turn';
  return `Turn ${modifier}${onto}`;
}

/** One spoken sentence for the maneuver at the start of `step`, without a trailing period. */
export function instructionFor(step: OsrmStep): string {
  try {
    compiler ??= osrmTextInstructions('v5');
    const text = compiler.compile('en', step);
    if (text) return text.replace(/\.$/, '');
  } catch (err) {
    console.warn('[nav] instruction compile failed', err);
  }
  return fallback(step);
}

export function metersPhrase(m: number): string {
  if (m < 1.5) return '1 meter';
  if (m < 15) return `${Math.round(m)} meters`;
  if (m < 100) return `${Math.round(m / 5) * 5} meters`;
  if (m < 1000) return `${Math.round(m / 10) * 10} meters`;
  return `${(m / 1000).toFixed(1)} kilometers`;
}
