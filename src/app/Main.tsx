import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore, type GeminiStatus, type Settings } from '../store';
import { distanceShort } from '../units';
import { CameraView } from './CameraView';
import { DevSim } from './DevSim';
import { ArrowIcon, CameraIcon, MicIcon, SlidersIcon, XRayIcon } from './icons';
import { Minimap } from './Minimap';
import { toggleMode } from './mode';

// three.js lives in its own chunk, but the download starts right away (not on first use), and the scene is
// mounted as soon as the main screen appears. Switching views is then just a reveal animation.
const loadXRay = () => import('../xray/XRayView');
const XRayView = lazy(loadXRay);
void loadXRay().catch(() => undefined);

const DOUBLE_TAP_MS = 350;
/** How long a finger must rest on the screen before hold-to-talk starts. */
const HOLD_MS = 280;
/** Movement beyond this before the hold registers means a drag, not a hold. */
const MOVE_TOLERANCE_PX = 12;

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

  return (
    <div className="status glass" aria-label="Status">
      <p className="status-place">{hasPos ? (building ?? (indoors ? 'Indoors' : 'Outdoors')) : 'Finding your location'}</p>
      {hasPos && (
        <p className="status-meta">
          {building && indoors ? 'Indoors · ' : ''}±{distanceShort(sigma, metric)}
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
  const setSetting = useStore((s) => s.setSetting);
  const talking = useStore((s) => s.talking);
  const isSim = useStore((s) => s.sim);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const lastTap = useRef(0);

  // The "press and hold" reminder shows for a few seconds after switching to hold-to-talk, then gets out of the way.
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    if (handsFree) return;
    setShowHint(true);
    const t = setTimeout(() => setShowHint(false), 4000);
    return () => clearTimeout(t);
  }, [handsFree]);

  // The screen behind the controls: press and hold to talk (when hands-free is off), double-tap to switch views.
  // Talking starts only once a finger has rested in place for HOLD_MS. A tap, a swipe, a press that began on a
  // button, the map or any panel, or a second finger never starts it.
  const hold = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null; held: boolean } | null>(null);

  const endHold = () => {
    const h = hold.current;
    hold.current = null;
    if (h?.timer) clearTimeout(h.timer);
    if (useStore.getState().talking) useStore.setState({ talking: false });
    return h;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (hold.current) {
      endHold(); // a second finger: this is a gesture, not a hold
      return;
    }
    if (!e.isPrimary || e.button !== 0) return;
    if ((e.target as Element).closest('button, a, input, select, textarea, [role="dialog"], .minimap, .sim')) return;
    const h = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: null as ReturnType<typeof setTimeout> | null, held: false };
    hold.current = h;
    if (!useStore.getState().settings.handsFree) {
      h.timer = setTimeout(() => {
        h.timer = null;
        if (hold.current !== h) return;
        h.held = true;
        useStore.setState({ talking: true });
        if ('vibrate' in navigator) navigator.vibrate(15);
      }, HOLD_MS);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const h = hold.current;
    if (!h || h.id !== e.pointerId || h.held) return;
    // Moved before the hold registered: the user is dragging or scrolling, not holding.
    if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > MOVE_TOLERANCE_PX) endHold();
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const h = hold.current;
    if (!h || h.id !== e.pointerId) return;
    endHold();
    if (h.held) return; // that was talking, not a tap
    const now = performance.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      toggleMode();
    } else {
      lastTap.current = now;
    }
  };

  const onPointerCancel = () => {
    endHold();
  };

  // Mic button in hold-to-talk mode.
  const stopTalking = () => {
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
        data-mode={mode}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Both views stay mounted; the x-ray layer is revealed in a circle growing out of the switch button. */}
        <div className="layer layer-camera" aria-hidden={mode !== 'camera'}>
          <CameraView active={mode === 'camera'} />
        </div>
        <div className="layer layer-xray" aria-hidden={mode !== 'xray'}>
          <Suspense fallback={null}>
            <XRayView active={mode === 'xray'} />
          </Suspense>
        </div>
      </div>

      <StatusLine />
      <Minimap />
      <Captions />

      {!handsFree && (talking || showHint) && (
        <p className="talk-hint glass" data-on={talking} aria-hidden="true">
          {talking ? 'Listening…' : 'Press and hold to talk'}
        </p>
      )}

      {handsFree ? (
        <button
          className="dock-button dock-right glass"
          aria-pressed
          aria-label="Hands-free listening"
          onClick={() => {
            setSetting('handsFree', false);
            useStore.getState().announce('Hold to talk. Hold this button or anywhere on the screen. Change back in settings.');
          }}
        >
          <MicIcon />
        </button>
      ) : (
        // Hold-to-talk mode: this is a hold button like the rest of the screen. It never switches modes
        // (that would turn the microphone back on by accident); hands-free is re-enabled in Settings.
        <button
          className="dock-button dock-right glass"
          aria-pressed={talking}
          aria-label="Hold to talk"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            useStore.setState({ talking: true });
          }}
          onPointerUp={stopTalking}
          onPointerCancel={stopTalking}
          onKeyDown={(e) => {
            if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) useStore.setState({ talking: true });
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') stopTalking();
          }}
          onBlur={stopTalking}
        >
          <MicIcon />
        </button>
      )}
      <button className="dock-button dock-left glass" aria-label="Settings" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
        <SlidersIcon />
      </button>

      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {isSim && <DevSim />}
    </main>
  );
}
