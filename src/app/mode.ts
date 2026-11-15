// Switching between the camera and the x-ray view (settings switch, double-tap, the agent's set_mode tool,
// or the hazard check, which opens the camera while a hazard is ahead and returns to x-ray once it is gone).

import { noteToAgent } from '../nav/announce';
import { useStore, type Mode } from '../store';

/** True while the camera view is showing only because the hazard check opened it. */
let hazardCamera = false;

/** @param byHazard the switch comes from the hazard check, not from the user or the guide. */
export function setMode(mode: Mode, byHazard = false): void {
  // Any switch the user (or guide) makes is theirs to keep: the hazard check stops managing the view.
  if (!byHazard) hazardCamera = false;
  const store = useStore.getState();
  if (store.mode === mode) return;
  useStore.setState({ mode });
  if (mode === 'xray') {
    // The camera stream is kept open (frames stop being sent) so switching back is instant.
    noteToAgent('view', 'Camera is off; user is in x-ray mode; rely on map data.');
    store.announce('X-ray view on.');
  } else {
    noteToAgent('view', 'Camera is on; user is in camera mode.');
    store.announce('Camera view on.');
  }
}

export function toggleMode(): void {
  setMode(useStore.getState().mode === 'camera' ? 'xray' : 'camera');
}

/** A hazard is ahead: show the camera so the guide can see it. */
export function openCameraForHazard(): void {
  if (useStore.getState().mode !== 'xray') return;
  hazardCamera = true;
  setMode('camera', true);
}

/** The path is clear again: go back to x-ray if the hazard check was what opened the camera. */
export function hazardCleared(): void {
  if (!hazardCamera) return;
  hazardCamera = false;
  if (useStore.getState().mode === 'camera') setMode('xray', true);
}
