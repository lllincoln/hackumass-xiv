// A small flat compass strip at the bottom center, between the dock buttons (shooter-game style): it slides as the phone turns, with a tick
// every 15° and letters at the cardinal and intercardinal points (the readout above gives the exact degrees),
// and a marker for the direction to walk. Moved every frame by transform, outside React, so it stays smooth.

import { useEffect, useMemo, useRef } from 'react';
import { angleDiff, norm360 } from '../geo';
import { orientation } from '../sensors/orientation';
import { useStore } from '../store';

/** Tick spacing: the strip shows more degrees as it gets wider, at the same density. */
const PX_PER_DEG = 1.9;
/** The target marker pins inside this fraction of the half-width (the ends fade out under the panels). */
const TARGET_PIN = 0.7;
const LETTERS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

type Tick = { deg: number; kind: 'minor' | 'letter'; label?: string };

export function CompassBar() {
  const barRef = useRef<HTMLDivElement>(null);
  const tapeRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);

  // One and a half turns either side of 0..360, so any heading has a full span of ticks around it.
  const ticks = useMemo(() => {
    const out: Tick[] = [];
    for (let d = -180; d <= 540; d += 15) {
      const n = norm360(d);
      out.push(LETTERS[n] ? { deg: d, kind: 'letter', label: LETTERS[n] } : { deg: d, kind: 'minor' });
    }
    return out;
  }, []);

  useEffect(() => {
    let raf = 0;
    let lastText = '';
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const bar = barRef.current;
      const tape = tapeRef.current;
      if (!bar || !tape) return;
      bar.dataset.ready = String(orientation.has);
      if (!orientation.has) return;

      const width = bar.clientWidth;
      const ppd = PX_PER_DEG;
      bar.style.setProperty('--ppd', `${ppd}px`);
      const h = norm360(orientation.heading);
      tape.style.transform = `translate3d(${width / 2 - h * ppd}px, 0, 0)`;

      const target = useStore.getState().nav?.targetBearing;
      const t = targetRef.current;
      if (t) {
        if (target == null) {
          t.hidden = true;
        } else {
          t.hidden = false;
          // Off the strip: pin it to the edge it is beyond, like a game's objective marker.
          const half = (width / 2 / ppd) * TARGET_PIN;
          const d = angleDiff(h, target);
          const clamped = Math.max(-half, Math.min(half, d));
          t.dataset.edge = d !== clamped ? (d < 0 ? 'left' : 'right') : '';
          t.style.transform = `translate3d(${width / 2 + clamped * ppd}px, 0, 0)`;
        }
      }

      const text = `${Math.round(h) % 360}° ${LETTERS[Math.round(h / 45) * 45 % 360]}`;
      if (text !== lastText && readoutRef.current) {
        readoutRef.current.textContent = text;
        lastText = text;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    // Visual only: the guide and the ticking sounds carry direction for people who cannot see it.
    <div ref={barRef} className="compass-bar" aria-hidden="true" data-ready="false">
      <div className="compass-window">
        <div ref={tapeRef} className="compass-tape">
          {ticks.map((t) => (
            <span key={t.deg} className={`compass-tick compass-${t.kind}`} style={{ left: `calc(var(--ppd) * ${t.deg})` }} data-north={t.label === 'N' || undefined}>
              {t.label && <span className="compass-label">{t.label}</span>}
            </span>
          ))}
        </div>
        <div className="compass-needle" />
      </div>
      {/* Outside the faded window, so it stays visible when pinned to an edge. */}
      <div ref={targetRef} className="compass-target" hidden />
      <span ref={readoutRef} className="compass-readout" />
    </div>
  );
}
