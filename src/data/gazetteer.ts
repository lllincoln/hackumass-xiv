// Fuzzy place search over the pack's gazetteer. Aliases ("CS Labs", "ILC") win over partial name matches.

import { dist, type Vec2 } from '../geo';
import { normalizeName, type PackIndex, type PlaceX } from './pack';

function bigrams(s: string): Set<string> {
  const t = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

/** 0…1 similarity between a normalized query and one normalized key. */
export function scoreKey(query: string, key: string): number {
  if (!query || !key) return 0;
  if (query === key) return 1;
  const qTokens = query.split(' ');
  const kTokens = key.split(' ');
  if (key.startsWith(`${query} `) || key.endsWith(` ${query}`)) return 0.9;
  if (qTokens.every((t) => kTokens.includes(t))) return 0.86;
  if (kTokens.every((t) => qTokens.includes(t)) && key.length >= 3) return 0.84;
  if (query.length >= 4 && key.includes(query)) return 0.8;
  if (qTokens.every((t) => kTokens.some((k) => k.startsWith(t) && t.length >= 3))) return 0.76;
  const d = dice(query, key);
  return d >= 0.55 ? d * 0.8 : 0;
}

export type PlaceMatch = { place: PlaceX; score: number; dist: number | null };

export function searchPlaces(index: PackIndex, query: string, from: Vec2 | null, limit = 3): PlaceMatch[] {
  const q = normalizeName(query);
  if (!q) return [];
  const matches: PlaceMatch[] = [];
  for (const place of index.places) {
    let score = 0;
    for (const key of place.keys) {
      const s = scoreKey(q, key);
      if (s > score) score = s;
    }
    if (score > 0) {
      // Buildings are what people usually mean; prefer them on ties.
      if (place.kind === 'building') score += 0.02;
      matches.push({ place, score, dist: from ? dist(from, place.pos) : null });
    }
  }
  matches.sort((a, b) => b.score - a.score || (a.dist ?? 0) - (b.dist ?? 0));
  // With one confident answer, do not pad the list with weak ones.
  const top = matches[0]?.score ?? 0;
  return matches.filter((m) => m.score >= Math.min(0.75, top - 0.15)).slice(0, limit);
}
