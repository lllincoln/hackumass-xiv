// One voice for everything: app announcements go through the Gemini session as text.
// If the session is down, the browser's speech synthesis says them instead.
// The session queues these and sends them between turns, so an announcement never cuts the guide off.

import { live, type TextOptions } from '../gemini/session';
import { useStore } from '../store';

export type AnnouncementKind = 'Navigation update' | 'Heads up';

export type AnnounceOptions = TextOptions & {
  /** Extra context for the model (ids and the like) that is neither shown nor spoken. */
  agentOnly?: string;
};

function speakLocally(text: string): void {
  if (!('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.05;
    // speak() queues behind anything already being said; it never cancels it.
    window.speechSynthesis.speak(u);
  } catch (err) {
    console.warn('[announce] speechSynthesis failed', err);
  }
}

export function announce(text: string, kind: AnnouncementKind = 'Navigation update', opts: AnnounceOptions = {}): void {
  const { agentOnly = '', ...textOpts } = opts;
  const sent = live.sendText(`${kind}: ${text} Say this to the user briefly.${agentOnly ? ` ${agentOnly}` : ''}`, textOpts);
  if (sent) return; // the guide says it, and its words appear as the caption
  useStore.getState().pushCaption('app', text, true);
  speakLocally(text);
}

/**
 * Context for the model that should not be spoken. It is held and delivered with the next spoken message or tool
 * result (sending it alone would make the guide reply out loud). A note with the same key replaces the older one.
 */
export function noteToAgent(key: string, text: string): void {
  live.note(key, text);
}
