import { useState } from 'react';
import { ensureAudio } from '../audio/context';
import { media } from '../sensors/media';
import {
  PERMISSION_EXPLANATIONS,
  requestAllPermissions,
  type PermissionKey,
  type PermissionResult,
} from '../sensors/permissions';
import { useStore } from '../store';
import { boot } from './boot';
import { LogoMark } from './icons';

const ORDER: PermissionKey[] = ['microphone', 'camera', 'location', 'orientation', 'motion', 'audio', 'wakeLock'];

const RESULT_WORDS: Record<PermissionResult, string> = {
  granted: 'on',
  denied: 'blocked',
  unsupported: 'not available on this device',
};

export function Start() {
  const pack = useStore((s) => s.pack);
  const packError = useStore((s) => s.packError);
  const isSim = useStore((s) => s.sim);
  const announce = useStore((s) => s.announce);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Partial<Record<PermissionKey, PermissionResult>>>({});

  const onStart = async () => {
    if (busy || !pack) return;
    setBusy(true);
    announce('Starting. Your phone will ask for a few permissions.');

    if (isSim) {
      // Simulator: sensors are faked. Still try audio, mic and camera so the voice agent can be tested on a laptop.
      await ensureAudio().catch(() => undefined);
      await media.openMic().catch(() => undefined);
      await media.openCamera().catch(() => undefined);
    } else {
      const report = await requestAllPermissions((key, result) => {
        setResults((r) => ({ ...r, [key]: result }));
        announce(`${PERMISSION_EXPLANATIONS[key].split(':')[0]} ${RESULT_WORDS[result]}.`);
      });
      const blocked = (Object.keys(report) as PermissionKey[]).filter((k) => report[k] === 'denied' && k !== 'wakeLock');
      if (blocked.length) {
        announce(`Started, but these are blocked: ${blocked.join(', ')}. Some features will be limited.`);
      }
    }

    boot(pack);
    useStore.setState({ started: true });
    announce('Wayfinder is on. Ask "what is in front of me?" or say where you want to go.');
  };

  return (
    <main className="start">
      <LogoMark className="start-mark" />
      <h1>Wayfinder</h1>
      <p className="start-tag">A voice guide and x-ray map for blind and low-vision people.</p>

      <button className="start-button" onClick={onStart} disabled={busy || !pack} aria-describedby="start-help">
        {packError ? 'Map failed to load' : !pack ? 'Loading map…' : busy ? 'Starting…' : 'Start'}
      </button>

      {packError && (
        <p className="start-error" role="alert">
          {packError}
        </p>
      )}

      <div id="start-help" className="start-help glass">
        <p>Tap Start, then allow each request. Earbuds work best.</p>
        <ul>
          {ORDER.map((key) => (
            <li key={key} data-result={results[key] ?? 'pending'}>
              {PERMISSION_EXPLANATIONS[key]}
              {results[key] && <span className="start-result"> ({RESULT_WORDS[results[key] as PermissionResult]})</span>}
            </li>
          ))}
        </ul>
        {isSim && <p className="start-sim">Simulator mode: position, compass and steps are simulated.</p>}
      </div>
    </main>
  );
}
