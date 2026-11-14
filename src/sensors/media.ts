// Camera and microphone streams. The camera is released in x-ray mode and reopened for camera mode.

import { useStore } from '../store';

type Listener = (stream: MediaStream | null) => void;

class Media {
  mic: MediaStream | null = null;
  camera: MediaStream | null = null;
  private cameraListeners = new Set<Listener>();
  private opening: Promise<MediaStream> | null = null;

  async openMic(): Promise<MediaStream> {
    if (this.mic?.active) return this.mic;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone unsupported');
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    return this.mic;
  }

  openCamera(): Promise<MediaStream> {
    if (this.camera?.active) return Promise.resolve(this.camera);
    if (this.opening) return this.opening;
    if (!navigator.mediaDevices?.getUserMedia) {
      useStore.setState({ cameraError: 'This browser cannot open the camera.' });
      return Promise.reject(new Error('camera unsupported'));
    }
    this.opening = navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      .then(
        (stream) => {
          this.camera = stream;
          useStore.setState({ cameraError: null });
          for (const l of this.cameraListeners) l(stream);
          return stream;
        },
        (err: unknown) => {
          useStore.setState({ cameraError: 'Camera is not available. Voice and x-ray still work.' });
          throw err;
        },
      )
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  closeCamera(): void {
    const stream = this.camera;
    this.camera = null;
    stream?.getTracks().forEach((t) => t.stop());
    for (const l of this.cameraListeners) l(null);
  }

  onCamera(listener: Listener): () => void {
    this.cameraListeners.add(listener);
    return () => this.cameraListeners.delete(listener);
  }
}

export const media = new Media();
