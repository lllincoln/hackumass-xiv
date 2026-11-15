// Tap-to-talk. One tap opens the microphone (rising tone); it closes by itself once the guide starts answering,
// or after a pause, with a falling tone. Tapping again closes it early. Tapping while the guide speaks cuts it off.
// In hands-free mode the microphone is always open, so a tap only cuts the guide off.

import { listenStartTone, listenStopTone } from '../audio/earcons';
import { live } from '../gemini/session';
import { useStore } from '../store';

/** Nothing heard this long after the tap: give up. */
const NO_SPEECH_MS = 7_000;
/** The user went quiet this long after speaking: their turn is over (the server usually notices sooner). */
const PAUSE_MS = 2_500;
/** Hard cap on one turn. */
const MAX_TURN_MS = 30_000;

let noSpeechTimer: ReturnType<typeof setTimeout> | null = null;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let maxTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  for (const t of [noSpeechTimer, pauseTimer, maxTimer]) if (t) clearTimeout(t);
  noSpeechTimer = pauseTimer = maxTimer = null;
}

export function isListening(): boolean {
  return useStore.getState().talking;
}

export function startTalking(): void {
  const { settings, talking, geminiStatus } = useStore.getState();
  live.cutOff();
  if (settings.handsFree || talking) return;
  if (geminiStatus !== 'live') {
    useStore.getState().announce('The guide is not connected yet.');
    return;
  }
  // No spoken "listening": a screen reader saying it would land in the microphone. The tone says it.
  useStore.setState({ talking: true });
  listenStartTone();
  clearTimers();
  noSpeechTimer = setTimeout(() => stopTalking(), NO_SPEECH_MS);
  maxTimer = setTimeout(() => stopTalking(), MAX_TURN_MS);
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
  useStore.subscribe((s, prev) => {
    if (!s.talking) return;
    if (s.geminiStatus !== 'live' && prev.geminiStatus === 'live') stopTalking(true);
    if (s.settings.handsFree && !prev.settings.handsFree) stopTalking(true);
  });
}
