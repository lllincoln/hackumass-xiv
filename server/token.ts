import { Hono } from 'hono';
import { GoogleGenAI, Modality, type FunctionDeclaration, type LiveConnectConfig } from '@google/genai';
import { DEFAULT_LIVE_MODEL, LIVE_API_VERSION, SYSTEM_INSTRUCTION, TOOL_DECLARATIONS } from '../shared/agent';
import { rateLimiter } from './ratelimit';

export const tokenRoutes = new Hono();

let ai: GoogleGenAI | null = null;
function client(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  ai ??= new GoogleGenAI({ apiKey, httpOptions: { apiVersion: LIVE_API_VERSION } });
  return ai;
}

/**
 * The session config every token is locked to. A locked token's setup replaces whatever the browser sends,
 * so the session-resumption handle has to be baked in here too (the client passes it when it reconnects).
 */
export function lockedLiveConfig(resumeHandle?: string): LiveConnectConfig {
  const voice = process.env.GEMINI_VOICE;
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: SYSTEM_INSTRUCTION,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    tools: [{ functionDeclarations: TOOL_DECLARATIONS as unknown as FunctionDeclaration[] }],
    ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
  };
}

const allow = rateLimiter(20, 60_000);

tokenRoutes.post('/token', async (c) => {
  if (!allow(c)) return c.json({ error: 'rate_limited' }, 429);
  const genai = client();
  if (!genai) return c.json({ error: 'gemini_not_configured' }, 503);

  const body = (await c.req.json().catch(() => null)) as { handle?: unknown } | null;
  const handle = typeof body?.handle === 'string' && body.handle.length > 0 && body.handle.length <= 8192 ? body.handle : undefined;

  const model = process.env.GEMINI_LIVE_MODEL || DEFAULT_LIVE_MODEL;
  const now = Date.now();
  try {
    const token = await genai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
        liveConnectConstraints: { model, config: lockedLiveConfig(handle) },
        httpOptions: { apiVersion: LIVE_API_VERSION },
      },
    });
    if (!token.name) throw new Error('token response had no name');
    c.header('Cache-Control', 'no-store');
    return c.json({ token: token.name, model });
  } catch (err) {
    console.error('[token] create failed', err);
    return c.json({ error: 'token_failed' }, 502);
  }
});
