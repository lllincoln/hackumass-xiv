// One voice for everything: app announcements go through the Gemini session as text.
// If the session is down, the browser's speech synthesis says them instead.

import { live } from '../gemini/session';
import { useStore } from '../store';

export type AnnouncementKind = 'Navigation update' | 'Heads up';

function speakLocally(text: string): void {
  if (!('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  } catch (err) {
    console.warn('[announce] speechSynthesis failed', err);
  }
}

/** @param agentOnly extra context for the model (ids and the like) that is neither shown nor spoken. */
export function announce(text: string, kind: AnnouncementKind = 'Navigation update', agentOnly = ''): void {
  const sent = live.sendText(`${kind}: ${text} Say this to the user briefly.${agentOnly ? ` ${agentOnly}` : ''}`);
  if (sent) return; // the guide says it, and its words appear as the caption
  useStore.getState().pushCaption('app', text, true);
  speakLocally(text);
}

/** Context for the model that should not be spoken. */
export function noteToAgent(text: string): void {
  live.sendText(`App note: ${text}`);
}
