// OSRM returns maneuver types, not sentences. osrm-text-instructions turns them into English.

import osrmTextInstructions from 'osrm-text-instructions';
import { distancePhrase } from '../units';
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

/** A distance in meters, spoken in the user's unit ("80 feet" or "25 meters"). */
export function metersPhrase(m: number): string {
  return distancePhrase(m);
}
