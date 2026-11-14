// Gemini Live session: connects straight from the browser with a single-use ephemeral token from /api/token.
// The token locks the model, system instruction, tools and resumption handle server-side.

import { GoogleGenAI, Modality, type FunctionCall, type FunctionResponse, type LiveServerMessage, type Session } from '@google/genai';
import { LIVE_API_VERSION } from '../../shared/agent';
import { useStore } from '../store';
import { MIC_MIME, startMic } from './audio-in';
import { flushPlayback, playChunk } from './audio-out';

const MAX_BACKOFF_MS = 15_000;

type ToolHandler = (calls: FunctionCall[]) => void;
type CancelHandler = (ids: string[]) => void;

class LiveAgent {
  private session: Session | null = null;
  /** Session-resumption handle from the server; lets a reconnect continue the same conversation. */
  private handle: string | null = null;
  private wantOpen = false;
  private attempts = 0;
  private failedResumes = 0;
  /** Incremented per connection attempt so callbacks from an old socket are ignored. */
  private epoch = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private micStarted = false;
  private wasTalking = false;

  onToolCall: ToolHandler | null = null;
  onToolCancel: CancelHandler | null = null;
  /** Called each time a session becomes live (first connect and every reconnect). */
  onLive: ((resumed: boolean) => void) | null = null;

  isLive(): boolean {
    return this.session !== null && useStore.getState().geminiStatus === 'live';
  }

  /** Open the session and keep it open (auto-reconnect) until `disconnect()`. */
  connect(): void {
    if (this.wantOpen) return;
    this.wantOpen = true;
    this.attempts = 0;
    void this.open();
  }

  disconnect(): void {
    this.wantOpen = false;
    this.epoch++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.closeSession();
    flushPlayback();
    useStore.setState({ geminiStatus: 'off' });
  }

  private closeSession(): void {
    const s = this.session;
    this.session = null;
    try {
      s?.close();
    } catch {
      /* already closed */
    }
  }

  private async open(): Promise<void> {
    const epoch = ++this.epoch;
    const resuming = this.handle !== null;
    useStore.setState({ geminiStatus: this.attempts === 0 && !resuming ? 'connecting' : 'reconnecting' });

    try {
      // A fresh single-use token for every connection, including reconnects.
      // The resumption handle goes to the server because the token's locked setup overrides ours.
      const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.handle ? { handle: this.handle } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 503) {
        // No API key on the server: nothing to retry quickly. Navigation and ticks keep working.
        if (epoch === this.epoch) {
          useStore.setState({ geminiStatus: 'unavailable' });
          this.scheduleRetry(60_000);
        }
        return;
      }
      if (!res.ok) throw new Error(`token HTTP ${res.status}`);
      const { token, model } = (await res.json()) as { token: string; model: string };
      if (epoch !== this.epoch || !this.wantOpen) return;

      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: LIVE_API_VERSION } });
      const session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          sessionResumption: this.handle ? { handle: this.handle } : {},
        },
        callbacks: {
          onopen: () => undefined,
          onmessage: (msg) => {
            if (epoch === this.epoch) this.handleMessage(msg);
          },
          onerror: (e) => console.warn('[live] socket error', e),
          onclose: (e) => {
            if (epoch !== this.epoch) return;
            console.warn('[live] closed', e.code, e.reason);
            this.session = null;
            flushPlayback();
            // A resume handle the server rejects would fail forever: drop it after two tries.
            if (resuming && ++this.failedResumes >= 2) {
              this.handle = null;
              this.failedResumes = 0;
            }
            if (this.wantOpen) this.scheduleRetry();
          },
        },
      });

      if (epoch !== this.epoch || !this.wantOpen) {
        session.close();
        return;
      }
      this.session = session;
      this.attempts = 0;
      useStore.setState({ geminiStatus: 'live' });
      void this.ensureMic();
      this.onLive?.(resuming);
    } catch (err) {
      console.warn('[live] connect failed', err);
      if (epoch === this.epoch && this.wantOpen) this.scheduleRetry();
    }
  }

  private scheduleRetry(delayMs?: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = delayMs ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts);
    this.attempts++;
    if (useStore.getState().geminiStatus !== 'unavailable') useStore.setState({ geminiStatus: 'reconnecting' });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wantOpen) void this.open();
    }, delay);
  }

  private async ensureMic(): Promise<void> {
    if (this.micStarted) return;
    this.micStarted = true;
    try {
      await startMic((data) => this.sendAudio(data));
    } catch (err) {
      this.micStarted = false;
      console.warn('[live] microphone unavailable', err);
      useStore.getState().announce('Microphone is not available. The guide cannot hear you.');
    }
  }

  private handleMessage(msg: LiveServerMessage): void {
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) flushPlayback();
      for (const part of sc.modelTurn?.parts ?? []) {
        const inline = part.inlineData;
        if (inline?.data && (inline.mimeType ?? 'audio/pcm').startsWith('audio/')) playChunk(inline.data, inline.mimeType);
      }
      const store = useStore.getState();
      if (sc.inputTranscription?.text) store.pushCaption('user', sc.inputTranscription.text);
      if (sc.outputTranscription?.text) store.pushCaption('agent', sc.outputTranscription.text);
      if (sc.turnComplete) store.finishCaptions();
    }

    if (msg.toolCall?.functionCalls?.length) this.onToolCall?.(msg.toolCall.functionCalls);
    if (msg.toolCallCancellation?.ids?.length) this.onToolCancel?.(msg.toolCallCancellation.ids);

    const resumption = msg.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      this.handle = resumption.newHandle;
      this.failedResumes = 0;
    }

    if (msg.goAway) {
      // The server is about to end this connection: reconnect now with the resumption handle.
      console.info('[live] goAway, reconnecting', msg.goAway.timeLeft);
      this.epoch++;
      this.closeSession();
      this.attempts = 0;
      if (this.wantOpen) void this.open();
    }
  }

  private sendAudio(base64Pcm: string): void {
    const s = this.session;
    if (!s) return;
    const { settings, talking } = useStore.getState();
    const open = settings.handsFree || talking;
    try {
      if (open) {
        s.sendRealtimeInput({ audio: { data: base64Pcm, mimeType: MIC_MIME } });
      } else if (this.wasTalking) {
        // Push-to-talk released: tell the server the audio stream paused so it answers right away.
        s.sendRealtimeInput({ audioStreamEnd: true });
      }
    } catch (err) {
      console.warn('[live] send audio failed', err);
    }
    this.wasTalking = open;
  }

  sendVideo(base64Jpeg: string): void {
    try {
      this.session?.sendRealtimeInput({ video: { data: base64Jpeg, mimeType: 'image/jpeg' } });
    } catch (err) {
      console.warn('[live] send video failed', err);
    }
  }

  /** Text into the live conversation. Returns false when the session is down (caller falls back to speechSynthesis). */
  sendText(text: string): boolean {
    if (!this.isLive() || !this.session) return false;
    try {
      this.session.sendRealtimeInput({ text });
      return true;
    } catch (err) {
      console.warn('[live] send text failed', err);
      return false;
    }
  }

  sendToolResponse(functionResponses: FunctionResponse[]): void {
    try {
      this.session?.sendToolResponse({ functionResponses });
    } catch (err) {
      console.warn('[live] tool response failed', err);
    }
  }
}

export const live = new LiveAgent();
