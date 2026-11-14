import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useStore, type GeminiStatus, type Settings } from '../store';
import { CameraView } from './CameraView';
import { DevSim } from './DevSim';
import { ArrowIcon, CameraIcon, MicIcon, SlidersIcon, XRayIcon } from './icons';
import { Minimap } from './Minimap';
import { toggleMode } from './mode';

// three.js is only needed for x-ray: keep it out of the first load.
const XRayView = lazy(() => import('../xray/XRayView'));

const DOUBLE_TAP_MS = 350;

const GEMINI_WORDS: Record<GeminiStatus, string> = {
  off: 'Guide off',
  connecting: 'Guide connecting',
  live: 'Guide ready',
  reconnecting: 'Guide reconnecting',
  unavailable: 'Guide unavailable',
};

function StatusLine() {
  const indoors = useStore((s) => s.indoors);
  const hasPos = useStore((s) => s.pos !== null);
  const sigma = useStore((s) => s.sigma);
  const building = useStore((s) => (s.buildingId ? s.pack?.buildingById.get(s.buildingId)?.name : undefined));
  const nav = useStore((s) => s.nav);
  const gemini = useStore((s) => s.geminiStatus);
  const speaking = useStore((s) => s.speaking);

  return (
    <div className="status glass" aria-label="Status">
      <p className="status-place">{hasPos ? (building ?? (indoors ? 'Indoors' : 'Outdoors')) : 'Finding your location'}</p>
      <p className="status-meta">
        <span className="status-dot" data-state={speaking ? 'speaking' : gemini} />
        <span>
          {hasPos ? `${building ? (indoors ? 'Indoors · ' : '') : ''}±${Math.round(sigma)} m · ` : ''}
          {speaking ? 'Guide speaking' : GEMINI_WORDS[gemini]}
        </span>
      </p>
      {nav && (
        <p className="status-target">
          <ArrowIcon />
          <span>
            {nav.label} · {nav.remainingM} m
          </span>
        </p>
      )}
    </div>
  );
}

function Captions() {
  const captions = useStore((s) => s.captions);
  const show = useStore((s) => s.settings.captions);
  if (!show || captions.length === 0) return null;
  return (
    // aria-hidden: the guide already speaks these; a screen reader repeating them would talk over it.
    <div className="captions glass" aria-hidden="true">
      {captions.slice(-2).map((c) => (
        <p key={c.id} className={`caption caption-${c.role}`}>
          <span className="caption-who">{c.role === 'user' ? 'You' : c.role === 'agent' ? 'Guide' : 'Wayfinder'}</span>
          {c.text}
        </p>
      ))}
    </div>
  );
}

const SWITCHES: { key: keyof Settings; title: string; detail: string; xrayOnly?: boolean }[] = [
  { key: 'handsFree', title: 'Hands-free listening', detail: 'Off: hold anywhere on the screen to talk.' },
  { key: 'captions', title: 'Captions', detail: 'Show what you and the guide say.' },
  { key: 'largeText', title: 'Large text', detail: 'Bigger captions, status and x-ray labels.' },
  { key: 'highContrast', title: 'High contrast', detail: 'Solid black panels with white outlines.' },
  { key: 'simplify', title: 'Simplify x-ray', detail: 'Only buildings, your route and the target.' },
];

function SettingsSheet({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <button className="sheet-backdrop" aria-label="Close settings" tabIndex={-1} onClick={onClose} />
      <section className="sheet glass" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="sheet-grip" aria-hidden="true" />
        <h2>Settings</h2>
        {SWITCHES.map(({ key, title, detail }) => (
          <button
            key={key}
            className="switch-row"
            role="switch"
            aria-checked={settings[key]}
            onClick={() => {
              setSetting(key, !settings[key]);
              useStore.getState().announce(`${title} ${settings[key] ? 'off' : 'on'}.`);
            }}
          >
            <span className="switch-text">
              <strong>{title}</strong>
              <span>{detail}</span>
            </span>
            <span className="switch-track" aria-hidden="true" />
          </button>
        ))}
        <button ref={doneRef} className="sheet-done" onClick={onClose}>
          Done
        </button>
      </section>
    </>
  );
}

export function Main() {
  const mode = useStore((s) => s.mode);
  const handsFree = useStore((s) => s.settings.handsFree);
  const setSetting = useStore((s) => s.setSetting);
  const talking = useStore((s) => s.talking);
  const isSim = useStore((s) => s.sim);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const lastTap = useRef(0);

  // The whole screen outside the buttons: hold to talk (when hands-free is off), double-tap to switch views.
  const onPointerDown = () => {
    if (!handsFree) useStore.setState({ talking: true });
  };
  const onPointerUp = () => {
    if (useStore.getState().talking) useStore.setState({ talking: false });
    const now = performance.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      toggleMode();
    } else {
      lastTap.current = now;
    }
  };
  const onPointerCancel = () => {
    if (useStore.getState().talking) useStore.setState({ talking: false });
  };

  return (
    <main className="main">
      {/* First in the DOM so it is the first thing VoiceOver / TalkBack reaches. */}
      <button className="mode-button" onClick={toggleMode} aria-label={mode === 'camera' ? 'X-ray view' : 'Camera view'}>
        {mode === 'camera' ? <XRayIcon /> : <CameraIcon />}
        <span>{mode === 'camera' ? 'X-ray' : 'Camera'}</span>
      </button>

      <div
        className={`stage ${talking ? 'stage-talking' : ''}`}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerCancel}
      >
        {mode === 'camera' ? (
          <CameraView />
        ) : (
          <Suspense fallback={<p className="camera-note">Loading x-ray…</p>}>
            <XRayView />
          </Suspense>
        )}
      </div>

      <StatusLine />
      <Minimap />
      <Captions />

      {!handsFree && (
        <p className="talk-hint glass" data-on={talking} aria-hidden="true">
          {talking ? 'Listening…' : 'Hold anywhere to talk'}
        </p>
      )}

      <button
        className="dock-button dock-right glass"
        aria-pressed={handsFree}
        aria-label="Hands-free listening"
        onClick={() => {
          setSetting('handsFree', !handsFree);
          useStore.getState().announce(handsFree ? 'Hold anywhere on the screen to talk.' : 'Hands-free: the guide is always listening.');
        }}
      >
        <MicIcon />
      </button>
      <button className="dock-button dock-left glass" aria-label="Settings" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
        <SlidersIcon />
      </button>

      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {isSim && <DevSim />}
    </main>
  );
}
