// Switching between the camera and the x-ray view (button, double-tap or the agent's set_mode tool).

import { noteToAgent } from '../nav/announce';
import { media } from '../sensors/media';
import { useStore, type Mode } from '../store';

export function setMode(mode: Mode): void {
  const store = useStore.getState();
  if (store.mode === mode) return;
  useStore.setState({ mode });
  if (mode === 'xray') {
    media.closeCamera();
    noteToAgent('Camera is off; user is in x-ray mode; rely on map data.');
    store.announce('X-ray view on. Camera off.');
  } else {
    void media.openCamera().catch(() => undefined);
    noteToAgent('Camera is on again; user is in camera mode.');
    store.announce('Camera view on.');
  }
}

export function toggleMode(): void {
  setMode(useStore.getState().mode === 'camera' ? 'xray' : 'camera');
}
