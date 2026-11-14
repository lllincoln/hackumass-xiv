import { useEffect, useRef, useState } from 'react';
import { live } from '../gemini/session';
import { startFrames, stopFrames } from '../gemini/video';
import { media } from '../sensors/media';
import { useStore } from '../store';

/** Full-screen camera feed. While `active`, it sends about one frame a second to the guide. */
export function CameraView({ active }: { active: boolean }) {
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

  // In x-ray mode the guide gets no frames (it is told the camera is off), but the stream stays warm
  // so switching back is instant.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream || !active) return;
    startFrames(video, (jpeg) => live.sendVideo(jpeg));
    return () => stopFrames();
  }, [stream, active]);

  return (
    <div className="camera">
      <video ref={videoRef} playsInline muted autoPlay aria-label="Live camera view" />
      {!stream && <p className="camera-note">{cameraError ?? 'Opening camera…'}</p>}
    </div>
  );
}
