// Distances for people: feet and miles by default, meters as a setting.
// Everything inside the app is in meters; conversion happens only where a distance is shown or spoken.

import { useStore } from './store';

const FT_PER_M = 3.28084;
const FT_PER_MILE = 5280;

export function isMetric(): boolean {
  return useStore.getState().settings.metric;
}

export function unitName(metric = isMetric()): 'meters' | 'feet' {
  return metric ? 'meters' : 'feet';
}

/** Round to a number a person would actually say: "80 feet", not "82 feet". */
function roundFeet(ft: number): number {
  if (ft < 10) return Math.max(1, Math.round(ft));
  if (ft < 100) return Math.round(ft / 5) * 5;
  if (ft < 500) return Math.round(ft / 10) * 10;
  return Math.round(ft / 50) * 50;
}

function roundMeters(m: number): number {
  if (m < 15) return Math.max(1, Math.round(m));
  if (m < 100) return Math.round(m / 5) * 5;
  return Math.round(m / 10) * 10;
}

/** Spoken form: "80 feet", "0.3 miles", "25 meters", "1.2 kilometers". */
export function distancePhrase(meters: number, metric = isMetric()): string {
  if (metric) {
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} kilometers`;
    const m = roundMeters(meters);
    return m === 1 ? '1 meter' : `${m} meters`;
  }
  const ft = meters * FT_PER_M;
  if (ft >= 1000) {
    const miles = (ft / FT_PER_MILE).toFixed(1);
    return miles === '1.0' ? '1 mile' : `${miles} miles`;
  }
  const r = roundFeet(ft);
  return r === 1 ? '1 foot' : `${r} feet`;
}

/** Compact form for the screen: "80 ft", "0.3 mi", "25 m", "1.2 km". */
export function distanceShort(meters: number, metric = isMetric()): string {
  if (metric) return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  const ft = meters * FT_PER_M;
  return ft >= 1000 ? `${(ft / FT_PER_MILE).toFixed(1)} mi` : `${roundFeet(ft)} ft`;
}
