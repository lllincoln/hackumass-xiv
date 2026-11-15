// Hazard check for one camera frame, with the Gemini Decisions API (gemini-decision-1): a yes/no question that comes
// back as a calibrated probability in well under a second (Gemma took 15-36 s per frame). The installed @google/genai
// predates this API, so it is called over REST: POST /v1beta/decisions.

import { Hono } from 'hono';
import { HAZARD_KINDS, HAZARD_SIDES, type HazardKind, type HazardResult, type HazardSide } from '../shared/hazards';
import { rateLimiter } from './ratelimit';

export const hazardRoutes = new Hono();

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const DEFAULT_MODEL = 'gemini-decision-1';
/**
 * P(something in the way) at or above this triggers a warning; tune with HAZARD_THRESHOLD. Erring toward warning:
 * anything in front of the user should be announced, so a frame the model is unsure about (about 0.5) counts.
 */
const DEFAULT_THRESHOLD = 0.45;
const MAX_IMAGE_CHARS = 2_000_000;
const TIMEOUT_MS = 8_000;

const QUESTION = {
  type: 'noul',
  instructions:
    'This image is from a phone camera held by a blind person who is walking forward, in the direction the camera faces. ' +
    'Is there anything in front of the camera, in or near their walking path, within about four meters (a few steps)? ' +
    'Anything at all counts, including people: a person standing or walking in front of them, a closed door, a wall, ' +
    'glass, a pole, stairs or a curb, a street or crosswalk they are about to step into, a hole or drop, a vehicle, bike, ' +
    'furniture, a bag or box on the ground, or any other object. Predict what they will reach if they keep walking, not ' +
    'only what is touching them. Only an open, empty path ahead (or things far away) is clear.',
  criteria: {
    true_description: 'Something (an object, a person, a door, a wall, a drop) is in front of them within a few steps.',
    false_description: 'Nothing is in front of them: the path ahead is open and empty for the next few steps.',
  },
} as const;

// Asked alongside, in the same call (the frame is read once): what the hazard is, and where, for a spoken warning
// that says what to do. Their answers only matter when the first question says there is a hazard.
const KIND_QUESTION = {
  type: 'choice',
  instructions:
    'A blind person is walking toward what this phone camera shows. What is the most important thing they are about ' +
    'to walk into, trip on or step into, directly in their path?',
  criteria: HAZARD_KINDS,
} as const;

const SIDE_QUESTION = {
  type: 'choice',
  instructions: 'Where in the image is the main obstacle or hazard in the walking path?',
  criteria: HAZARD_SIDES,
} as const;

type DecisionResponse = {
  answers?: {
    hazard?: { type: 'noul'; noul: number };
    kind?: { type: 'choice'; choice: string };
    side?: { type: 'choice'; choice: string };
  };
};

// The client checks every 2 s (up to 30 a minute, one request at a time); this leaves headroom for that and retries.
const allow = rateLimiter(60, 60_000);

async function decide(apiKey: string, image: string, threshold: number): Promise<HazardResult> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: `models/${process.env.HAZARD_MODEL || DEFAULT_MODEL}`,
      input: [{ type: 'image', mime_type: 'image/jpeg', data: image }],
      questions: { hazard: QUESTION, kind: KIND_QUESTION, side: SIDE_QUESTION },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw Object.assign(new Error((await res.text()).slice(0, 200)), { status: res.status });
  const answers = ((await res.json()) as DecisionResponse).answers;
  const p = answers?.hazard?.noul;
  if (typeof p !== 'number') throw new Error('no hazard answer in the response');
  const hazard = p >= threshold;
  const kind = answers?.kind?.choice;
  const side = answers?.side?.choice;
  return {
    hazard,
    probability: Math.round(p * 100) / 100,
    ...(hazard && kind && kind in HAZARD_KINDS ? { kind: kind as HazardKind } : {}),
    ...(hazard && side && side in HAZARD_SIDES ? { side: side as HazardSide } : {}),
  };
}

hazardRoutes.post('/hazard', async (c) => {
  if (!allow(c)) return c.json({ error: 'rate_limited' }, 429);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return c.json({ error: 'gemini_not_configured' }, 503);

  const body = (await c.req.json().catch(() => null)) as { image?: unknown } | null;
  const image = body?.image;
  if (typeof image !== 'string' || image.length === 0 || image.length > MAX_IMAGE_CHARS) {
    return c.json({ error: 'bad_image' }, 400);
  }

  const threshold = Number(process.env.HAZARD_THRESHOLD) || DEFAULT_THRESHOLD;
  // Retry once on a server error or timeout before giving up on this frame.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await decide(apiKey, image, threshold);
      c.header('Cache-Control', 'no-store');
      return c.json(result);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (attempt < 2 && (status === undefined || status >= 500)) continue;
      // One line, not a stack trace: this runs every few seconds per user.
      console.warn(`[hazard] check failed (${status ?? 'network'}): ${(err as Error).message?.slice(0, 160)}`);
      return c.json({ error: 'hazard_failed' }, 502);
    }
  }
  return c.json({ error: 'hazard_failed' }, 502);
});
