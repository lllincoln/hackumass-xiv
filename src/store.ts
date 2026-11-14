import { create } from 'zustand';
import type { LonLat, Vec2 } from './geo';
import type { PackIndex } from './data/pack';
import type { LL } from './data/types';
import type { ReportDTO } from '../shared/reports';

export type Mode = 'camera' | 'xray';
export type GeminiStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'unavailable';

export type NavStep = {
  /** Spoken instruction for the maneuver at the start of this step. */
  text: string;
  /** Distance along the route to the maneuver, meters. */
  s: number;
  pos: Vec2;
  type: string;
  modifier?: string;
  name: string;
};

export type RouteX = {
  line: Vec2[];
  cum: number[];
  coords: LL[];
  totalM: number;
  durationS: number;
  steps: NavStep[];
};

export type NavState = {
  kind: 'route' | 'point';
  label: string;
  dest: Vec2;
  destLL: LonLat;
  route: RouteX | null;
  /** When routing from indoors: the exit door to reach first. */
  entrance: { pos: Vec2; buildingId: string; reached: boolean } | null;
  /** Index of the next maneuver in route.steps. */
  stepIndex: number;
  remainingM: number;
  /** Direction the user should face right now, degrees from north. */
  targetBearing: number | null;
  /** Community reports lying on the active route. */
  reportIds: string[];
};

export type Caption = { id: number; role: 'user' | 'agent' | 'app'; text: string; final: boolean };

export type Settings = {
  captions: boolean;
  largeText: boolean;
  simplify: boolean;
  handsFree: boolean;
  iosHaptic: boolean;
  highContrast: boolean;
  /** Distances in meters instead of feet. */
  metric: boolean;
};

const SETTINGS_KEY = 'wayfinder.settings';
const defaultSettings: Settings = { captions: true, largeText: false, simplify: false, handsFree: true, iosHaptic: false, highContrast: false, metric: false };

function loadSettings(): Settings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    return raw ? { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export type State = {
  sim: boolean;
  started: boolean;
  mode: Mode;
  pack: PackIndex | null;
  packError: string | null;

  /** Fused position estimate, ENU meters. */
  pos: Vec2 | null;
  /** Position uncertainty, meters. */
  sigma: number;
  gpsAccuracy: number | null;
  indoors: boolean;
  buildingId: string | null;
  /** Smoothed compass heading of where the phone points, degrees from north. */
  heading: number | null;

  nav: NavState | null;
  reports: ReportDTO[];

  geminiStatus: GeminiStatus;
  speaking: boolean;
  /** Push-to-talk held (only matters when hands-free is off). */
  talking: boolean;
  captions: Caption[];

  cameraError: string | null;
  minimapExpanded: boolean;
  lowPerf: boolean;
  /** Latest state change, read out by the aria-live region. */
  announcement: string;
  settings: Settings;

  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  announce: (text: string) => void;
  pushCaption: (role: Caption['role'], text: string, final?: boolean) => void;
  finishCaptions: () => void;
};

let captionSeq = 0;

export const useStore = create<State>()((set) => ({
  sim: typeof location !== 'undefined' && new URLSearchParams(location.search).get('sim') === '1',
  started: false,
  mode: 'camera',
  pack: null,
  packError: null,

  pos: null,
  sigma: 30,
  gpsAccuracy: null,
  indoors: false,
  buildingId: null,
  heading: null,

  nav: null,
  reports: [],

  geminiStatus: 'off',
  speaking: false,
  talking: false,
  captions: [],

  cameraError: null,
  minimapExpanded: false,
  lowPerf: false,
  announcement: '',
  settings: loadSettings(),

  setSetting: (key, value) =>
    set((s) => {
      const settings = { ...s.settings, [key]: value };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* private mode */
      }
      return { settings };
    }),

  announce: (text) => set({ announcement: text }),

  pushCaption: (role, text, final = false) =>
    set((s) => {
      const last = s.captions[s.captions.length - 1];
      // Transcripts stream in fragments: extend the open line for the same speaker.
      if (last && last.role === role && !last.final) {
        const merged = { ...last, text: last.text + text, final };
        return { captions: [...s.captions.slice(0, -1), merged] };
      }
      const closed = s.captions.map((c) => (c.final ? c : { ...c, final: true }));
      return { captions: [...closed, { id: ++captionSeq, role, text, final }].slice(-6) };
    }),

  finishCaptions: () => set((s) => ({ captions: s.captions.map((c) => (c.final ? c : { ...c, final: true })) })),
}));

export const getState = () => useStore.getState();
