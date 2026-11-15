import { Hono } from 'hono';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { rateLimiter } from './ratelimit';

export const hazardRoutes = new Hono();

const DEFAULT_HAZARD_MODEL = 'gemma-4-31b-it';
const MAX_IMAGE_CHARS = 2_000_000;

const PROMPT = `This image is from a phone camera held by a blind person who is walking. Is there a hazard directly in front of them that they could walk into or trip on within the next few steps? Hazards include walls, doors, poles, stairs or curbs, holes, vehicles, bikes, people, furniture and other obstacles in their path. Anything off to the side or far away is not a hazard.
Respond with exactly one letter: T if there is a hazard, F if not. No other text.`;

let ai: GoogleGenAI | null = null;
function client(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  ai ??= new GoogleGenAI({ apiKey });
  return ai;
}

// The client checks every 3-10 s, one request at a time; this leaves headroom for that.
const allow = rateLimiter(30, 60_000);

hazardRoutes.post('/hazard', async (c) => {
  if (!allow(c)) return c.json({ error: 'rate_limited' }, 429);
  const genai = client();
  if (!genai) return c.json({ error: 'gemini_not_configured' }, 503);

  const body = (await c.req.json().catch(() => null)) as { image?: unknown } | null;
  const image = body?.image;
  if (typeof image !== 'string' || image.length === 0 || image.length > MAX_IMAGE_CHARS) {
    return c.json({ error: 'bad_image' }, 400);
  }

  try {
    const res = await genai.models.generateContent({
      model: process.env.GEMMA_HAZARD_MODEL || DEFAULT_HAZARD_MODEL,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: image } }, { text: PROMPT }] }],
      config: {
        temperature: 0,
        // Minimal thinking makes Gemma answer straight away (an empty thought part, then the letter).
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        maxOutputTokens: 4,
      },
    });
    const answer = (res.text ?? '').trim().toUpperCase();
    c.header('Cache-Control', 'no-store');
    return c.json({ hazard: answer.startsWith('T') });
  } catch (err) {
    console.error('[hazard] check failed', err);
    return c.json({ error: 'hazard_failed' }, 502);
  }
});
