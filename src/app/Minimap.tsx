// Heading-up minimap (MapLibre + OSM raster tiles) in the top-right corner. Tap to expand, tap again to shrink.
// The pack's own buildings and paths are drawn as vectors, so the map still works if tiles fail to load.
//
// The camera (center + bearing) is eased every animation frame toward the user's position and heading, so the
// map turns smoothly as the phone turns. Panning the expanded map pauses that; it recenters by itself a few
// seconds after the last touch, when "Recenter" is pressed, or when the map is closed.

import type { Feature, FeatureCollection } from 'geojson';
import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { HELPFUL_KINDS } from '../../shared/reports';
import { toLonLat, type PackIndex } from '../data/pack';
import { angleDiff, fromENU } from '../geo';
import { orientation } from '../sensors/orientation';
import { sim } from '../sensors/sim';
import { useStore, type State } from '../store';

type FC = FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };

const DEFAULT_ZOOM = 17.6;
/** After the user pans or zooms, follow mode comes back by itself after this long. */
const RECENTER_AFTER_MS = 4000;
/** Easing rates (1/s): higher = snappier. */
const TURN_RATE = 9;
/** How fast the map camera catches the displayed position (matters after a pan; otherwise it is already there). */
const MOVE_RATE = 10;
/** How fast the displayed position glides toward the estimate. Lower = smoother, but lags more. */
const GLIDE_RATE = 9;
/** A change this large is a teleport (simulator click, first fix): jump instead of gliding across campus. */
const TELEPORT_M = 40;

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0d12' } },
    { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-opacity': 0.38, 'raster-saturation': -0.85, 'raster-brightness-max': 0.75 } },
  ],
};

function staticData(pack: PackIndex): { buildings: FC; ways: FC; features: FC } {
  return {
    buildings: {
      type: 'FeatureCollection',
      features: pack.raw.buildings.map((b) => ({
        type: 'Feature',
        properties: { id: b.id },
        geometry: {
          type: 'Polygon',
          coordinates: [[...b.outer, b.outer[0]], ...(b.holes ?? []).map((h) => [...h, h[0]])],
        },
      })),
    },
    ways: {
      type: 'FeatureCollection',
      features: pack.raw.ways
        .filter((w) => w.kind !== 'road')
        .map((w) => ({ type: 'Feature', properties: { kind: w.kind }, geometry: { type: 'LineString', coordinates: w.coords } })),
    },
    features: {
      type: 'FeatureCollection',
      features: pack.features
        .map((f) => ({ type: 'Feature', properties: { kind: f.kind }, geometry: { type: 'Point', coordinates: [f.lon, f.lat] } })),
    },
  };
}

function circle(pack: PackIndex, center: { x: number; y: number }, radius: number): FC {
  const ring: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const ll = fromENU(pack.origin, center.x + Math.cos(a) * radius, center.y + Math.sin(a) * radius);
    ring.push([ll.lon, ll.lat]);
  }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] };
}

function point(lon: number, lat: number, properties: Record<string, unknown> = {}): Feature {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

function addLayers(map: maplibregl.Map, pack: PackIndex): void {
  const data = staticData(pack);
  map.addSource('buildings', { type: 'geojson', data: data.buildings });
  map.addSource('ways', { type: 'geojson', data: data.ways });
  map.addSource('features', { type: 'geojson', data: data.features });
  for (const id of ['route', 'sigma', 'reports', 'target', 'me']) map.addSource(id, { type: 'geojson', data: EMPTY });

  map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings', paint: { 'fill-color': '#a9d1f7', 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'buildings-line', type: 'line', source: 'buildings', paint: { 'line-color': '#a9d1f7', 'line-width': 1.2, 'line-opacity': 0.8 } });
  map.addLayer({
    id: 'ways',
    type: 'line',
    source: 'ways',
    paint: {
      'line-color': ['match', ['get', 'kind'], 'steps', '#f29a40', 'crossing', '#ffffff', '#7f9bb8'],
      'line-width': 1.4,
      'line-opacity': 0.7,
    },
  });
  map.addLayer({ id: 'sigma', type: 'fill', source: 'sigma', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.16 } });
  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffc53d', 'line-width': 5 },
  });
  map.addLayer({
    id: 'features',
    type: 'circle',
    source: 'features',
    minzoom: 16,
    paint: {
      'circle-radius': 3,
      'circle-color': [
        'match',
        ['get', 'kind'],
        'bench', '#f3d9a4',
        'trash', '#c9b8ff',
        'bike_parking', '#8fe3b0',
        'bus_stop', '#ffb38a',
        'water', '#7cc4ff',
        '#ffffff',
      ],
      'circle-stroke-color': '#000000',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: 'reports',
    type: 'circle',
    source: 'reports',
    paint: {
      'circle-radius': ['case', ['get', 'onRoute'], 10, 7],
      'circle-color': ['case', ['get', 'helpful'], '#5ee6a8', '#ff6b5e'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'target',
    type: 'circle',
    source: 'target',
    paint: { 'circle-radius': 8, 'circle-color': '#ffc53d', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: 'me',
    type: 'circle',
    source: 'me',
    paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#2f7cf6', 'circle-stroke-width': 3 },
  });
}

export function Minimap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  /** Set by the effect below; lets the buttons resume follow mode. */
  const recenterRef = useRef<() => void>(() => undefined);
  const pack = useStore((s) => s.pack);
  const expanded = useStore((s) => s.minimapExpanded);
  const isSim = useStore((s) => s.sim);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pack) return;

    const map = new maplibregl.Map({
      container,
      style: STYLE,
      center: [pack.origin.lon, pack.origin.lat],
      zoom: DEFAULT_ZOOM,
      maxZoom: 20,
      attributionControl: false, // replaced by a small fixed credit: the default control covers the minimap
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    let last: Partial<Pick<State, 'nav' | 'reports'>> = {};
    let ready = false;
    const setData = (id: string, data: FC) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);

    // ---- data layers follow the store ------------------------------------------------------------
    const sync = () => {
      if (!ready) return;
      const s = useStore.getState();

      const route = s.nav?.route ?? null;
      if (s.nav !== last.nav) {
        if (route !== (last.nav?.route ?? null) || !s.nav) {
          setData(
            'route',
            route
              ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coords } }] }
              : EMPTY,
          );
        }
        setData('target', s.nav ? { type: 'FeatureCollection', features: [point(s.nav.destLL.lon, s.nav.destLL.lat)] } : EMPTY);
      }

      if (s.reports !== last.reports || s.nav?.reportIds !== last.nav?.reportIds) {
        setData('reports', {
          type: 'FeatureCollection',
          features: s.reports.map((r) =>
            point(r.lon, r.lat, { helpful: HELPFUL_KINDS.includes(r.kind), onRoute: s.nav?.reportIds.includes(r.id) ?? false }),
          ),
        });
      }
      last = { nav: s.nav, reports: s.reports };
    };

    // ---- camera: eased follow, every frame -------------------------------------------------------
    let follow = true;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFrame = performance.now();
    let frame = 0;
    let snap = true; // jump straight to the user the first time, then ease
    let shown: { x: number; y: number } | null = null;
    let shownSigma = useStore.getState().sigma;
    let drawn: { x: number; y: number; sigma: number } | null = null;

    const resume = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (!follow) {
        follow = true;
        setFollowing(true);
      }
    };
    recenterRef.current = resume;

    const pause = () => {
      if (follow) {
        follow = false;
        setFollowing(false);
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(resume, RECENTER_AFTER_MS);
    };
    // Pause as soon as a finger or the wheel touches the expanded map. This has to happen before MapLibre's own
    // drag handling: our per-frame camera updates would otherwise cancel the gesture as it starts.
    const onTouch = () => {
      if (useStore.getState().minimapExpanded) pause();
    };
    container.addEventListener('pointerdown', onTouch, { capture: true });
    container.addEventListener('wheel', onTouch, { capture: true, passive: true });
    // Keep it paused for as long as the gesture goes on.
    const onUserMove = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) pause();
    };
    map.on('drag', onUserMove);
    map.on('zoom', onUserMove);

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      const { pos, sigma, minimapExpanded } = useStore.getState();
      if (!pos || !ready) return;

      // The position estimate arrives in jumps (a GPS fix a second, 0.7 m per step). Glide a displayed
      // position toward it, and draw the dot and accuracy circle there, so nothing on the map ever hops.
      if (!shown || Math.hypot(pos.x - shown.x, pos.y - shown.y) > TELEPORT_M) {
        shown = { ...pos };
        drawn = null;
      } else {
        const k = 1 - Math.exp(-dt * GLIDE_RATE);
        shown = { x: shown.x + (pos.x - shown.x) * k, y: shown.y + (pos.y - shown.y) * k };
      }
      shownSigma += (sigma - shownSigma) * (1 - Math.exp(-dt * GLIDE_RATE));
      if (!drawn || Math.hypot(shown.x - drawn.x, shown.y - drawn.y) > 0.02 || Math.abs(shownSigma - drawn.sigma) > 0.05) {
        const ll = toLonLat(pack, shown);
        setData('me', { type: 'FeatureCollection', features: [point(ll.lon, ll.lat)] });
        setData('sigma', circle(pack, shown, shownSigma));
        drawn = { ...shown, sigma: shownSigma };
      }
      if (!follow) return;

      const target = toLonLat(pack, shown);
      const wantBearing = orientation.has ? orientation.heading : 0;
      const wantZoom = minimapExpanded ? map.getZoom() : DEFAULT_ZOOM;
      if (snap) {
        snap = false;
        map.jumpTo({ center: [target.lon, target.lat], bearing: wantBearing, zoom: wantZoom });
        return;
      }
      const c = map.getCenter();
      const kMove = 1 - Math.exp(-dt * MOVE_RATE);
      const kTurn = 1 - Math.exp(-dt * TURN_RATE);
      const turn = angleDiff(map.getBearing(), wantBearing);
      const dLon = target.lon - c.lng;
      const dLat = target.lat - c.lat;
      const dZoom = wantZoom - map.getZoom();
      // Skip the update once settled, so an idle map costs nothing.
      if (Math.abs(turn) < 0.05 && Math.abs(dLon) < 1e-7 && Math.abs(dLat) < 1e-7 && Math.abs(dZoom) < 0.005) return;
      map.jumpTo({
        center: [c.lng + dLon * kMove, c.lat + dLat * kMove],
        bearing: map.getBearing() + turn * kTurn,
        zoom: map.getZoom() + dZoom * kMove,
      });
    };

    map.on('load', () => {
      addLayers(map, pack);
      ready = true;
      sync();
      frame = requestAnimationFrame(tick);
    });

    map.on('click', (e) => {
      const s = useStore.getState();
      if (!s.minimapExpanded) return;
      // Dev simulator: click to set the position. Otherwise a tap on the expanded map shrinks it.
      if (s.sim) {
        sim.teleport({ lon: e.lngLat.lng, lat: e.lngLat.lat });
        resume();
      } else useStore.setState({ minimapExpanded: false });
    });

    // Coalesce store changes into one data update per frame.
    let pending = 0;
    let wasExpanded = useStore.getState().minimapExpanded;
    const unsubscribe = useStore.subscribe((s) => {
      // Opening or closing the map always goes back to "follow me".
      if (s.minimapExpanded !== wasExpanded) {
        wasExpanded = s.minimapExpanded;
        resume();
      }
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        sync();
      });
    });

    // The container animates between its small and full-screen sizes: keep the canvas matched to it.
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    return () => {
      unsubscribe();
      observer.disconnect();
      container.removeEventListener('pointerdown', onTouch, { capture: true });
      container.removeEventListener('wheel', onTouch, { capture: true });
      if (pending) cancelAnimationFrame(pending);
      if (frame) cancelAnimationFrame(frame);
      if (idleTimer) clearTimeout(idleTimer);
      map.remove();
      mapRef.current = null;
    };
  }, [pack]);

  const setExpanded = (value: boolean) => {
    useStore.setState({ minimapExpanded: value });
    useStore.getState().announce(value ? 'Map expanded.' : 'Map minimized.');
  };

  return (
    <div className={`minimap ${expanded ? 'minimap-expanded' : ''}`}>
      <div ref={containerRef} className="minimap-canvas" aria-hidden="true" />
      {following && <span className="minimap-arrow" aria-hidden="true" />}
      <span className="minimap-credit">© OpenStreetMap</span>
      {expanded ? (
        <>
          <button className="minimap-close" onClick={() => setExpanded(false)}>
            Close map
          </button>
          {!following && (
            <button className="minimap-recenter glass" onClick={() => recenterRef.current()}>
              Recenter
            </button>
          )}
        </>
      ) : (
        <button className="minimap-open" onClick={() => setExpanded(true)} aria-label="Expand map" />
      )}
      {expanded && isSim && <p className="minimap-hint">Simulator: click the map to set your position.</p>}
    </div>
  );
}
