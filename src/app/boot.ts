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
import { startHeading } from '../sensors/heading';
import { startMotion } from '../sensors/motion';
import { sim } from '../sensors/sim';
import { useStore } from '../store';

let booted = false;

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
  live.onLive = () => {
    // A new or resumed session does not know the view changed while it was away.
    if (useStore.getState().mode === 'xray') noteToAgent('Camera is off; user is in x-ray mode; rely on map data.');
  };
  live.connect();
}
