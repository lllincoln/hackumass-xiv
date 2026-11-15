import { useEffect, useRef, useState } from 'react';
import { live } from '../gemini/session';
import { startFrames, stopFrames } from '../gemini/video';
import { startHazardWatcher } from '../hazard/watcher';
import { media } from '../sensors/media';
import { useStore } from '../store';

/** Camera feed, hidden behind the x-ray view. It always sends about one frame a second to the guide and runs the hazard check. */
export function CameraView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraError = useStore((s) => s.cameraError);
  const [stream, setStream] = useState<MediaStream | null>(media.camera);

  useEffect(() => {
    const off = media.onCamera(setStream);
    setStream(media.camera);
    if (!media.camera) void media.openCamera().catch(() => undefined);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (!stream) return;
    void video.play().catch(() => undefined);
  }, [stream]);

  // The user never sees this feed, but the guide does.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    startFrames(video, (jpeg) => live.sendVideo(jpeg));
    return () => stopFrames();
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    return startHazardWatcher(video);
  }, [stream]);

  return (
    <div className="camera">
      <video ref={videoRef} playsInline muted autoPlay aria-label="Live camera view" />
      {!stream && <p className="camera-note">{cameraError ?? 'Opening camera…'}</p>}
    </div>
  );
}
