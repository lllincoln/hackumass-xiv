import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useStore, type GeminiStatus, type Settings } from '../store';
import { distanceShort } from '../units';
import { CameraView } from './CameraView';
import { CompassBar } from './CompassBar';
import { DevSim } from './DevSim';
import { ArrowIcon, MicIcon, SlidersIcon } from './icons';
import { Minimap } from './Minimap';
import { toggleTalk } from './talk';

// three.js lives in its own chunk, but the download starts right away (not on first use), and the scene is
// mounted as soon as the main screen appears. Switching views is then just a reveal animation.
const loadXRay = () => import('../xray/XRayView');
const XRayView = lazy(loadXRay);
void loadXRay().catch(() => undefined);


/** Only problems are shown: when the guide is working there is nothing to say about it. */
const GEMINI_PROBLEMS: Partial<Record<GeminiStatus, string>> = {
  reconnecting: 'Guide reconnecting',
  unavailable: 'Guide unavailable',
};

function StatusLine() {
  const indoors = useStore((s) => s.indoors);
  const hasPos = useStore((s) => s.pos !== null);
  const sigma = useStore((s) => s.sigma);
  const building = useStore((s) => (s.buildingId ? s.pack?.buildingById.get(s.buildingId)?.name : undefined));
  const nav = useStore((s) => s.nav);
  const problem = useStore((s) => GEMINI_PROBLEMS[s.geminiStatus]);
  const metric = useStore((s) => s.settings.metric);

  // Accuracy at a glance: green within 5 m, amber within 15 m, red beyond.
  const quality = sigma <= 5 ? 'good' : sigma <= 15 ? 'fair' : 'poor';

  return (
    <div className="status" aria-label="Status">
      <p className="status-place">{hasPos ? (building ?? (indoors ? 'Indoors' : 'Outdoors')) : 'Locating…'}</p>
      {hasPos && (
        <p className="status-meta">
          <span className="status-accuracy" data-quality={quality} aria-hidden="true" />
          <span className="nowrap">±{distanceShort(sigma, metric)}</span>
          {building && indoors && <span className="nowrap">· Indoors</span>}
        </p>
      )}
      {problem && (
        <p className="status-meta status-problem">
          <span className="status-dot" />
          {problem}
        </p>
      )}
      {nav && (
        <p className="status-target">
          <ArrowIcon />
          <span>
            {nav.label} · {distanceShort(nav.remainingM, metric)}
          </span>
        </p>
      )}
    </div>
  );
}

/** A caption stays this long after its last word arrives, then fades out over CAPTION_FADE_MS. */
const CAPTION_HOLD_MS = 6000;
const CAPTION_FADE_MS = 1000;

function Captions() {
  const captions = useStore((s) => s.captions);
  const show = useStore((s) => s.settings.captions);
  const [now, setNow] = useState(() => Date.now());

  const recent = captions.slice(-2).filter((c) => now - c.at < CAPTION_HOLD_MS + CAPTION_FADE_MS);
  // Re-render while something is on screen, so lines start fading and then leave on time.
  const live = show && recent.length > 0;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [live]);
  // A new or growing caption arrives: show it immediately instead of waiting for the next tick.
  useEffect(() => setNow(Date.now()), [captions]);

  if (!show || recent.length === 0) return null;
  const fading = (c: (typeof recent)[number]) => now - c.at >= CAPTION_HOLD_MS;
  return (
    // aria-hidden: the guide already speaks these; a screen reader repeating them would talk over it.
    <div className={`captions glass ${recent.every(fading) ? 'captions-fading' : ''}`} aria-hidden="true">
      {recent.map((c) => (
        <p key={c.id} className={`caption caption-${c.role} ${fading(c) ? 'caption-fading' : ''}`}>
          <span className="caption-who">{c.role === 'user' ? 'You' : c.role === 'agent' ? 'Guide' : 'Wayfinder'}</span>
          {c.text}
        </p>
      ))}
    </div>
  );
}

const SWITCHES: { key: keyof Settings; title: string; detail: string; xrayOnly?: boolean }[] = [
  { key: 'handsFree', title: 'Hands-free listening', detail: 'Off: tap the microphone button to talk.' },
  { key: 'headsetButton', title: 'Headset button', detail: 'Play/pause on headphones starts talking. Not every phone supports it.' },
  { key: 'captions', title: 'Captions', detail: 'Show what you and the guide say.' },
  { key: 'largeText', title: 'Large text', detail: 'Bigger captions, status and x-ray labels.' },
  { key: 'highContrast', title: 'High contrast', detail: 'Solid black panels with white outlines.' },
  { key: 'metric', title: 'Metric units', detail: 'Off: feet and miles. On: meters.' },
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
  const talking = useStore((s) => s.talking);
  const speaking = useStore((s) => s.speaking);
  const isSim = useStore((s) => s.sim);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The "tap to talk" reminder shows for a few seconds after switching off hands-free, then gets out of the way.
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    if (handsFree) return;
    setShowHint(true);
    const t = setTimeout(() => setShowHint(false), 4000);
    return () => clearTimeout(t);
  }, [handsFree]);

  const micLabel = handsFree ? (speaking ? 'Stop the guide' : 'Listening hands-free') : talking ? 'Stop listening' : 'Talk';
  const onMic = () => {
    if (handsFree && !speaking) {
      useStore.getState().announce('Listening hands-free. Just speak. Tap-to-talk is in settings.');
      return;
    }
    toggleTalk();
  };

  return (
    <main className="main">
      <div
        className={`stage ${talking ? 'stage-talking' : ''}`}
        data-mode={mode}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* The screen always shows x-ray. The camera stays mounted but hidden: the guide and the hazard check still get its frames. */}
        <div className="layer layer-camera" aria-hidden={mode !== 'camera'}>
          <CameraView />
        </div>
        <div className="layer layer-xray" aria-hidden={mode !== 'xray'}>
          <Suspense fallback={null}>
            <XRayView active={mode === 'xray'} />
          </Suspense>
        </div>
      </div>

      <CompassBar />
      <StatusLine />
      <Minimap />
      <Captions />

      {!handsFree && (talking || showHint) && (
        <p className="talk-hint glass" data-on={talking} aria-hidden="true">
          {talking ? 'Listening…' : 'Tap the microphone to talk'}
        </p>
      )}

      {/* One tap: talk (tap-to-talk) or cut the guide off. It never changes settings. */}
      <button
        className="dock-button dock-right glass"
        aria-pressed={handsFree || talking}
        aria-label={micLabel}
        data-on={talking}
        onClick={onMic}
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
