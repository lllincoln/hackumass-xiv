// Tap-to-talk. One tap opens the microphone (rising tone); it closes by itself once the guide starts answering,
// or after a pause, with a falling tone. Tapping again closes it early. Tapping while the guide speaks cuts it off.
// When the guide ends its turn with a question, the microphone reopens by itself (rising tone) once its voice has
// finished playing, so the user can just answer. In hands-free mode the microphone is always open, so a tap only
// cuts the guide off.

import { listenStartTone, listenStopTone } from '../audio/earcons';
import { live } from '../gemini/session';
import { useStore } from '../store';

/** Nothing heard this long after the tap: give up. */
const NO_SPEECH_MS = 7_000;
/** After the guide asks a question, wait this long for an answer before closing again. */
const FOLLOW_UP_NO_SPEECH_MS = 8_000;
/**
 * The user went quiet this long after speaking: their turn is over. Only a fallback (the mic normally closes when
 * the guide starts replying), so it is generous enough not to cut people off mid-sentence.
 */
const PAUSE_MS = 4_000;
/** A question is only followed up this soon after it was asked (a stale one is not answered by surprise). */
const FOLLOW_UP_WINDOW_MS = 20_000;
/** A short gap after the guide's voice ends, so the tone and the mic do not catch its last syllable. */
const FOLLOW_UP_GAP_MS = 300;
/** Hard cap on one turn. */
const MAX_TURN_MS = 30_000;

let noSpeechTimer: ReturnType<typeof setTimeout> | null = null;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let maxTimer: ReturnType<typeof setTimeout> | null = null;
/** The guide asked a question at this time; reopen the mic once it has finished speaking. */
let followUpAskedAt: number | null = null;
let followUpTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  for (const t of [noSpeechTimer, pauseTimer, maxTimer]) if (t) clearTimeout(t);
  noSpeechTimer = pauseTimer = maxTimer = null;
}

export function isListening(): boolean {
  return useStore.getState().talking;
}

/** @param followUp opened by itself after the guide asked a question (nothing to cut off; a longer wait). */
export function startTalking(followUp = false): void {
  const { settings, talking, geminiStatus } = useStore.getState();
  followUpAskedAt = null;
  if (!followUp) live.cutOff();
  if (settings.handsFree || talking) return;
  if (geminiStatus !== 'live') {
    useStore.getState().announce('The guide is not connected yet.');
    return;
  }
  // No spoken "listening": a screen reader saying it would land in the microphone. The tone says it.
  useStore.setState({ talking: true });
  listenStartTone();
  clearTimers();
  noSpeechTimer = setTimeout(() => stopTalking(), followUp ? FOLLOW_UP_NO_SPEECH_MS : NO_SPEECH_MS);
  maxTimer = setTimeout(() => stopTalking(), MAX_TURN_MS);
}

/** Does this turn end with a question for the user? (Allowing a closing quote or bracket after the "?".) */
function endsWithQuestion(text: string): boolean {
  return /\?\s*["'”’)\]]*\s*$/.test(text);
}

/** Reopen the mic for an answer once the guide's voice has finished, if a question is pending. */
function tryFollowUp(): void {
  if (followUpAskedAt === null || followUpTimer) return;
  const s = useStore.getState();
  if (Date.now() - followUpAskedAt > FOLLOW_UP_WINDOW_MS || s.settings.handsFree || s.talking) {
    followUpAskedAt = null;
    return;
  }
  if (s.speaking || s.geminiStatus !== 'live') return; // try again when the voice stops
  followUpTimer = setTimeout(() => {
    followUpTimer = null;
    const now = useStore.getState();
    if (followUpAskedAt !== null && !now.speaking && !now.talking) startTalking(true);
  }, FOLLOW_UP_GAP_MS);
}

/** @param quiet skip the tone (the session dropped, or hands-free took over). */
export function stopTalking(quiet = false): void {
  clearTimers();
  if (!useStore.getState().talking) return;
  useStore.setState({ talking: false });
  if (!quiet) listenStopTone();
}

/** What the talk button, a headset button and a hardware key do. */
export function toggleTalk(): void {
  if (isListening()) stopTalking();
  else startTalking();
}

/** Wire the talk turn to the conversation: stop listening when the reply starts or the user pauses. */
export function installTalk(): void {
  live.onReplyStart = () => {
    if (isListening()) stopTalking();
  };
  live.onUserSpeech = () => {
    if (!isListening()) return;
    if (noSpeechTimer) clearTimeout(noSpeechTimer);
    noSpeechTimer = null;
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => stopTalking(), PAUSE_MS);
  };
  live.onTurnEnd = (text) => {
    if (useStore.getState().settings.handsFree || !endsWithQuestion(text)) return;
    followUpAskedAt = Date.now();
    tryFollowUp();
  };
  useStore.subscribe((s, prev) => {
    // The guide's voice just finished playing: answer time, if it asked something.
    if (!s.speaking && prev.speaking) tryFollowUp();
    // It started speaking again before the follow-up opened (another sentence queued): wait for that one.
    if (s.speaking && !prev.speaking && followUpTimer) {
      clearTimeout(followUpTimer);
      followUpTimer = null;
    }
    if (!s.talking) return;
    if (s.geminiStatus !== 'live' && prev.geminiStatus === 'live') stopTalking(true);
    if (s.settings.handsFree && !prev.settings.handsFree) stopTalking(true);
  });
}
