// Heading-up minimap (MapLibre + OSM raster tiles) in the top-right corner. Tap to expand, tap again to shrink.
// The pack's own buildings and paths are drawn as vectors, so the map still works if tiles fail to load.

import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection } from 'geojson';
import { useEffect, useRef } from 'react';
import { HELPFUL_KINDS } from '../../shared/reports';
import { toLonLat, type PackIndex } from '../data/pack';
import { fromENU } from '../geo';
import { sim } from '../sensors/sim';
import { useStore, type State } from '../store';

type FC = FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };

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
        .filter((f) => f.kind !== 'tree')
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

export function Minimap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pack = useStore((s) => s.pack);
  const expanded = useStore((s) => s.minimapExpanded);
  const isSim = useStore((s) => s.sim);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pack) return;

    const map = new maplibregl.Map({
      container,
      style: STYLE,
      center: [pack.origin.lon, pack.origin.lat],
      zoom: 17.6,
      maxZoom: 20,
      attributionControl: false, // replaced by a small fixed credit below: the default control covers the minimap
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;

    let last: Partial<Pick<State, 'pos' | 'sigma' | 'heading' | 'nav' | 'reports'>> = {};
    let ready = false;

    const setData = (id: string, data: FC) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);

    const sync = () => {
      if (!ready) return;
      const s = useStore.getState();

      if (s.pos !== last.pos || s.sigma !== last.sigma) {
        if (s.pos) {
          const ll = toLonLat(pack, s.pos);
          setData('me', { type: 'FeatureCollection', features: [point(ll.lon, ll.lat)] });
          setData('sigma', circle(pack, s.pos, s.sigma));
        } else {
          setData('me', EMPTY);
          setData('sigma', EMPTY);
        }
      }

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

      // Heading-up: the map turns so that "up" is where the phone points, and it follows the user.
      if (s.pos && (s.pos !== last.pos || s.heading !== last.heading)) {
        const ll = toLonLat(pack, s.pos);
        map.jumpTo({ center: [ll.lon, ll.lat], bearing: s.heading ?? 0 });
      }

      last = { pos: s.pos, sigma: s.sigma, heading: s.heading, nav: s.nav, reports: s.reports };
    };

    map.on('load', () => {
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

      ready = true;
      sync();
    });

    map.on('click', (e) => {
      const s = useStore.getState();
      if (!s.minimapExpanded) return;
      // Dev simulator: click to set the position. Otherwise a tap on the expanded map shrinks it.
      if (s.sim) sim.teleport({ lon: e.lngLat.lng, lat: e.lngLat.lat });
      else useStore.setState({ minimapExpanded: false });
    });

    // Coalesce store changes into one map update per frame.
    let frame = 0;
    const unsubscribe = useStore.subscribe(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    });

    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      map.remove();
      mapRef.current = null;
    };
  }, [pack]);

  useEffect(() => {
    // The container changes size with the expand/shrink transition.
    const t = setTimeout(() => mapRef.current?.resize(), 60);
    return () => clearTimeout(t);
  }, [expanded]);

  const setExpanded = (value: boolean) => {
    useStore.setState({ minimapExpanded: value });
    useStore.getState().announce(value ? 'Map expanded.' : 'Map minimized.');
  };

  return (
    <div className={`minimap ${expanded ? 'minimap-expanded' : ''}`}>
      <div ref={containerRef} className="minimap-canvas" aria-hidden="true" />
      <span className="minimap-arrow" aria-hidden="true" />
      <span className="minimap-credit">© OpenStreetMap</span>
      {expanded ? (
        <button className="minimap-close" onClick={() => setExpanded(false)}>
          Close map
        </button>
      ) : (
        <button className="minimap-open" onClick={() => setExpanded(true)} aria-label="Expand map" />
      )}
      {expanded && isSim && <p className="minimap-hint">Simulator: click the map to set your position.</p>}
    </div>
  );
}
