// Gemini Live session: connects straight from the browser with a single-use ephemeral token from /api/token.
// The token locks the model, system instruction, tools and resumption handle server-side.

import { GoogleGenAI, Modality, type FunctionCall, type FunctionResponse, type LiveServerMessage, type Session } from '@google/genai';
import { LIVE_API_VERSION } from '../../shared/agent';
import { useStore } from '../store';
import { MIC_MIME, startMic } from './audio-in';
import { flushPlayback, playChunk } from './audio-out';

const MAX_BACKOFF_MS = 15_000;
/** If a turn never reports turnComplete (lost message, silent reply), stop waiting after this long. */
const BUSY_TIMEOUT_MS = 20_000;
/** After the user's turn ends, the reply normally starts within this long; app messages wait at most this much. */
const REPLY_WAIT_MS = 8_000;
/** Mic audio kept from before a tap (5 chunks of 100 ms), so the first words are not lost. */
const PRE_ROLL_CHUNKS = 5;

type ToolHandler = (calls: FunctionCall[]) => void;
type CancelHandler = (ids: string[]) => void;

export type TextOptions = {
  /** A queued message with the same key is replaced (e.g. a newer navigation update supersedes an older one). */
  key?: string;
  /** Drop the message if it could not be sent within this long. */
  maxAgeMs?: number;
  /** Safety first: cut the guide off and send now instead of waiting for the turn to end (hazard warnings). */
  urgent?: boolean;
};

type Outgoing = { text: string; key?: string; expiresAt: number };

/** "10s" / "1.5s" (protobuf Duration as JSON) → milliseconds. */
function durationMs(d: string | undefined): number | null {
  const m = d ? /^([\d.]+)s$/.exec(d) : null;
  return m ? Number(m[1]) * 1000 : null;
}

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
  /** The most recent mic chunks while nobody is listening, sent first when listening starts. */
  private preRoll: string[] = [];
  /** The model has produced output since its last turn ended. */
  private inModelTurn = false;
  /** The user cut the guide off: drop the rest of that reply until the server ends or interrupts it. */
  private muted = false;

  /**
   * Any text sent into the session while the model is answering (or the user is speaking) makes the server
   * drop the reply in progress and the guide cuts itself off. App messages therefore wait here and go out
   * one at a time, between turns.
   */
  private outbox: Outgoing[] = [];
  /**
   * Silent context for the model (view changes, units, listening mode), latest per key. Text sent on its own makes
   * the model take a turn and say something ("Okay, camera's on"), so these never go out alone: they ride along
   * with the next spoken app message or tool result.
   */
  private notes = new Map<string, string>();
  private busy = false;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  /** A goAway arrived mid-turn: reconnect once the turn finishes (or the server's deadline nears). */
  private reconnectPending = false;
  private goAwayTimer: ReturnType<typeof setTimeout> | null = null;

  onToolCall: ToolHandler | null = null;
  onToolCancel: CancelHandler | null = null;
  /** Called each time a session becomes live (first connect and every reconnect). */
  onLive: ((resumed: boolean) => void) | null = null;
  /** The model started answering (audio or text), i.e. the user's turn is over. */
  onReplyStart: (() => void) | null = null;
  /** A piece of the user's speech was transcribed. */
  onUserSpeech: (() => void) | null = null;

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
    this.outbox = [];
    this.setIdle();
    this.cancelPendingReconnect();
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
            this.setIdle();
            // Audio already received keeps playing; flushing here would cut the guide off mid-sentence.
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
      this.setIdle();
      useStore.setState({ geminiStatus: 'live' });
      void this.ensureMic();
      this.onLive?.(resuming);
      this.pump();
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
      // Barge-in by the user. Their own turn follows, so stay busy until it completes.
      if (sc.interrupted) {
        flushPlayback();
        this.markBusy();
        this.inModelTurn = false;
        this.muted = false;
      }
      const output = Boolean(sc.modelTurn?.parts?.length || sc.outputTranscription?.text);
      if (output && !this.muted) {
        for (const part of sc.modelTurn?.parts ?? []) {
          const inline = part.inlineData;
          if (inline?.data && (inline.mimeType ?? 'audio/pcm').startsWith('audio/')) playChunk(inline.data, inline.mimeType);
        }
        if (!this.inModelTurn) this.onReplyStart?.();
      }
      if (output) {
        this.inModelTurn = true;
        this.markBusy();
      }
      // The user is talking: an app message now would cut into their turn.
      if (sc.inputTranscription?.text) {
        this.markBusy();
        this.onUserSpeech?.();
      }
      const store = useStore.getState();
      if (sc.inputTranscription?.text) store.pushCaption('user', sc.inputTranscription.text);
      if (sc.outputTranscription?.text && !this.muted) store.pushCaption('agent', sc.outputTranscription.text);
      if (sc.turnComplete) {
        store.finishCaptions();
        this.inModelTurn = false;
        this.muted = false;
        this.setIdle();
        if (this.reconnectPending) this.reconnectNow();
        else this.pump();
      }
    }

    // The model is mid-turn waiting on a tool; it continues speaking after the response.
    if (msg.toolCall?.functionCalls?.length) this.markBusy();
    if (msg.toolCall?.functionCalls?.length) this.onToolCall?.(msg.toolCall.functionCalls);
    if (msg.toolCallCancellation?.ids?.length) this.onToolCancel?.(msg.toolCallCancellation.ids);

    const resumption = msg.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      this.handle = resumption.newHandle;
      this.failedResumes = 0;
    }

    if (msg.goAway) {
      // The server is about to end this connection. Reconnecting closes the socket, which would cut off a reply
      // in progress, so let the current turn finish first unless the deadline is close.
      console.info('[live] goAway', msg.goAway.timeLeft);
      if (!this.busy) {
        this.reconnectNow();
      } else if (!this.reconnectPending) {
        this.reconnectPending = true;
        const left = durationMs(msg.goAway.timeLeft) ?? 5000;
        this.goAwayTimer = setTimeout(() => this.reconnectNow(), Math.max(0, left - 1000));
      }
    }
  }

  private cancelPendingReconnect(): void {
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    this.reconnectPending = false;
  }

  private reconnectNow(): void {
    this.cancelPendingReconnect();
    this.epoch++;
    this.closeSession();
    this.setIdle();
    this.attempts = 0;
    if (this.wantOpen) void this.open();
  }

  private markBusy(timeoutMs = BUSY_TIMEOUT_MS): void {
    this.busy = true;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      this.busy = false;
      this.pump();
    }, timeoutMs);
  }

  private setIdle(): void {
    this.busy = false;
    this.inModelTurn = false;
    this.muted = false;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
  }

  /** Send the next queued app message if the conversation is between turns. */
  private pump(): void {
    // While the user holds the floor (tapped to talk), app messages wait.
    if (this.busy || this.reconnectPending || useStore.getState().talking || !this.isLive() || !this.session) return;
    const now = Date.now();
    this.outbox = this.outbox.filter((m) => m.expiresAt > now);
    if (this.outbox.length === 0) return;
    // Everything that piled up goes out as one message, so the model answers it in a single turn,
    // with any pending silent notes in front of it.
    const text = [...this.takeNotes(), ...this.outbox.map((m) => m.text)].join('\n');
    this.outbox = [];
    try {
      this.session.sendRealtimeInput({ text });
      // The reply has not started yet, but it is coming: nothing else goes out until it completes.
      this.markBusy();
    } catch (err) {
      console.warn('[live] send text failed', err);
    }
  }

  private sendAudio(base64Pcm: string): void {
    const s = this.session;
    if (!s) return;
    const { settings, talking } = useStore.getState();
    const open = settings.handsFree || talking;
    try {
      if (open) {
        // Just opened: the words spoken while tapping are in the pre-roll.
        for (const chunk of this.preRoll) s.sendRealtimeInput({ audio: { data: chunk, mimeType: MIC_MIME } });
        this.preRoll = [];
        s.sendRealtimeInput({ audio: { data: base64Pcm, mimeType: MIC_MIME } });
      } else {
        if (this.wasTalking) {
          // Tap-to-talk ended: tell the server the audio stream paused so it answers right away.
          s.sendRealtimeInput({ audioStreamEnd: true });
          this.markBusy(REPLY_WAIT_MS);
        }
        this.preRoll.push(base64Pcm);
        if (this.preRoll.length > PRE_ROLL_CHUNKS) this.preRoll.shift();
      }
    } catch (err) {
      console.warn('[live] send audio failed', err);
    }
    this.wasTalking = open;
  }

  /** Silence the guide now (the user wants to speak). The rest of its current reply is dropped. */
  cutOff(): void {
    flushPlayback();
    if (this.inModelTurn) this.muted = true;
  }

  sendVideo(base64Jpeg: string): void {
    try {
      this.session?.sendRealtimeInput({ video: { data: base64Jpeg, mimeType: 'image/jpeg' } });
    } catch (err) {
      console.warn('[live] send video failed', err);
    }
  }

  /**
   * Text into the live conversation. It is queued and sent only between turns, so it never cuts off the guide
   * or the user. Returns false when the session is down (caller falls back to speechSynthesis).
   */
  sendText(text: string, opts: TextOptions = {}): boolean {
    if (!this.isLive() || !this.session) return false;
    if (opts.urgent) {
      // Anything queued is folded in so it is not lost; silent notes (the view switched to camera) go first.
      const text2 = [...this.takeNotes(), ...this.outbox.filter((m) => m.key !== opts.key).map((m) => m.text), text].join('\n');
      this.outbox = [];
      this.cutOff();
      try {
        this.session.sendRealtimeInput({ text: text2 });
        this.markBusy();
        return true;
      } catch (err) {
        console.warn('[live] urgent send failed', err);
        return false;
      }
    }
    const msg: Outgoing = { text, key: opts.key, expiresAt: Date.now() + (opts.maxAgeMs ?? Infinity) };
    const i = opts.key ? this.outbox.findIndex((m) => m.key === opts.key) : -1;
    if (i >= 0) this.outbox[i] = msg;
    else this.outbox.push(msg);
    this.pump();
    return true;
  }

  /** Silent context: delivered with the next spoken message or tool result, never on its own. Same key replaces. */
  note(key: string, text: string): void {
    this.notes.set(key, text);
  }

  private takeNotes(): string[] {
    const out = [...this.notes.values()].map((t) => `App note: ${t}`);
    this.notes.clear();
    return out;
  }

  sendToolResponse(functionResponses: FunctionResponse[]): void {
    // Pending notes go out inside the first result: the model reads them without taking an extra turn.
    if (this.notes.size && functionResponses[0]) {
      const [first, ...rest] = functionResponses;
      functionResponses = [{ ...first, response: { ...(first.response ?? {}), app_notes: this.takeNotes() } }, ...rest];
    }
    try {
      this.session?.sendToolResponse({ functionResponses });
    } catch (err) {
      console.warn('[live] tool response failed', err);
    }
  }
}

export const live = new LiveAgent();
