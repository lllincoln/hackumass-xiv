// Dev simulator panel (`?sim=1`): drive position, heading and GPS quality from a laptop,
// and run the agent's tools by hand so navigation, x-ray and reports can be tested without the voice session.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { runTool } from '../gemini/tools';
import { sim, type GpsQuality } from '../sensors/sim';
import { useStore } from '../store';

function useSim() {
  return useSyncExternalStore(
    (cb) => sim.subscribe(cb),
    () => `${sim.heading}|${sim.pitch}|${sim.gps}|${sim.recording}|${sim.replaying}|${sim.truth?.lon}|${sim.truth?.lat}|${sim.track.length}`,
  );
}

export function DevSim() {
  useSim();
  const nav = useStore((s) => s.nav);
  const iosHaptic = useStore((s) => s.settings.iosHaptic);
  const setSetting = useStore((s) => s.setSetting);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('CS Labs');
  const [output, setOutput] = useState('');

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    setOutput(`${name}…`);
    const result = await runTool(name, args);
    setOutput(`${name} → ${JSON.stringify(result, null, 1)}`);
    return result;
  };

  const navigateTo = async () => {
    const found = (await call('find_place', { query })) as { results?: { place_id: string; name: string }[] };
    const first = found.results?.[0];
    if (first) await call('start_navigation', { place_id: first.place_id, label: first.name });
  };

  // Arrow keys: turn and walk.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowLeft') sim.setHeading(sim.heading - 10);
      else if (e.key === 'ArrowRight') sim.setHeading(sim.heading + 10);
      else if (e.key === 'ArrowUp') sim.walk(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) {
    return (
      <button className="sim-open glass" onClick={() => setOpen(true)}>
        Sim
      </button>
    );
  }

  return (
    <section className="sim glass" aria-label="Developer simulator">
      <header>
        <strong>Simulator</strong>
        <button onClick={() => setOpen(false)}>Hide</button>
      </header>

      <label>
        Heading {Math.round(sim.heading)}°
        <input type="range" min={0} max={359} value={Math.round(sim.heading)} onChange={(e) => sim.setHeading(Number(e.target.value))} />
      </label>
      <label>
        Tilt {Math.round(sim.pitch)}°
        <input type="range" min={-60} max={60} value={Math.round(sim.pitch)} onChange={(e) => sim.setPitch(Number(e.target.value))} />
      </label>

      <div className="sim-row">
        <button onClick={() => sim.walk(1)}>Walk 1 step</button>
        <button onClick={() => sim.walk(10)}>Walk 10</button>
        <label>
          GPS{' '}
          <select value={sim.gps} onChange={(e) => sim.setGps(e.target.value as GpsQuality)}>
            <option value="good">good</option>
            <option value="indoor">indoor (bad)</option>
            <option value="off">off</option>
          </select>
        </label>
      </div>

      <div className="sim-row">
        <button onClick={() => sim.toggleRecording()} aria-pressed={sim.recording}>
          {sim.recording ? `Stop recording (${sim.track.length})` : 'Record route'}
        </button>
        <button onClick={() => sim.replay(nav?.route?.line)} disabled={!sim.replaying && !nav?.route && sim.track.length < 2}>
          {sim.replaying ? 'Stop replay' : nav?.route ? 'Walk the route' : `Replay recording (${sim.track.length})`}
        </button>
      </div>

      <div className="sim-row">
        <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Place to find" />
        <button onClick={() => void call('find_place', { query })}>Find</button>
        <button onClick={() => void navigateTo()}>Navigate</button>
        <button onClick={() => void call('stop_navigation')}>Stop</button>
      </div>

      <div className="sim-row">
        <button onClick={() => void call('get_context')}>Context</button>
        <button onClick={() => void call('find_nearby', { kind: 'bench' })}>Nearest bench</button>
        <button onClick={() => void call('describe_xray_view')}>Describe view</button>
        <button onClick={() => void call('get_reports_nearby', { radius_m: 200 })}>Reports</button>
        <button onClick={() => void call('report_hazard', { kind: 'construction', description: 'Construction fence across the sidewalk.' })}>
          Report fence here
        </button>
      </div>

      <label className="sim-check">
        <input type="checkbox" checked={iosHaptic} onChange={(e) => setSetting('iosHaptic', e.target.checked)} /> iOS haptic tick (experimental)
      </label>

      <p className="sim-keys">Keys: ← → turn, ↑ walk. Expand the map and click to set position.</p>
      {output && <pre className="sim-output">{output}</pre>}
    </section>
  );
}
