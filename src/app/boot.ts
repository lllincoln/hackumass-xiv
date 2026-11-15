// Starts every subsystem once the user has tapped Start and permissions are settled.

import { keepAudioAlive } from '../audio/context';
import { searchPlaces } from '../data/gazetteer';
import type { PackIndex } from '../data/pack';
import { startFeedback } from '../feedback/engine';
import { live } from '../gemini/session';
import { installTools } from '../gemini/tools';
import { startLocation } from '../location';
import { noteToAgent } from '../nav/announce';
import { startNavigator } from '../nav/navigator';
import { startReportWatcher } from '../reports/watcher';
import { startGeolocation } from '../sensors/geolocation';
import { startMediaKeys } from '../sensors/mediakeys';
import { startHeading } from '../sensors/heading';
import { startMotion } from '../sensors/motion';
import { sim } from '../sensors/sim';
import { useStore } from '../store';
import { unitName } from '../units';
import { installTalk } from './talk';

let booted = false;

function listeningNote(): string {
  return useStore.getState().settings.handsFree
    ? 'Listening is hands-free: you hear the user all the time.'
    : 'Listening is tap-to-talk: you hear the user only after they tap the talk button.';
}

/** Where the simulator starts: just outside the ILC when the pack knows it, else the middle of campus. */
function simStart(pack: PackIndex) {
  const ilc = searchPlaces(pack, 'Integrative Learning Center', null, 1)[0]?.place;
  return ilc ? { lon: ilc.lon, lat: ilc.lat } : pack.origin;
}

export function boot(pack: PackIndex): void {
  if (booted) return;
  booted = true;
  const isSim = useStore.getState().sim;

  startLocation(pack);
  startNavigator();
  startFeedback();
  keepAudioAlive();

  if (isSim) {
    sim.start(simStart(pack));
  } else {
    startHeading();
    startMotion();
    startGeolocation();
  }

  startReportWatcher();

  installTools();
  installTalk();
  startMediaKeys();
  live.onLive = () => {
    noteToAgent('view', 'The screen shows the x-ray map; you still get the camera feed, which the user does not see.');
    noteToAgent('units', `The user wants distances in ${unitName()}.`);
    noteToAgent('listening', listeningNote());
  };
  live.connect();
  // Tell the guide when the unit setting changes mid-conversation.
  useStore.subscribe((s, prev) => {
    if (s.settings.metric !== prev.settings.metric) noteToAgent('units', `The user now wants distances in ${unitName()}.`);
    if (s.settings.handsFree !== prev.settings.handsFree) noteToAgent('listening', listeningNote());
  });
}
