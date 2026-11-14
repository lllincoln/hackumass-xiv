// Keeps nearby community reports in the store and warns the first time the user comes close to one.

import { HELPFUL_KINDS, REPORT_LABELS, type ReportDTO } from '../../shared/reports';
import { toLocal, toLonLat } from '../data/pack';
import { angleDiff, bearingENU, dist, relativeWords } from '../geo';
import { announce } from '../nav/announce';
import { metersPhrase } from '../nav/instructions';
import { orientation } from '../sensors/orientation';
import { useStore } from '../store';
import { reportsApi } from './api';

const POLL_MS = 10_000;
const POLL_RADIUS_M = 60;
const WARN_RADIUS_M = 15;

const warned = new Set<string>();
/** Reports this device created: no need to warn their author. */
const mine = new Set<string>();
let polling = false;

export function markOwnReport(id: string): void {
  mine.add(id);
  warned.add(id);
}

export function upsertReport(r: ReportDTO): void {
  const { reports } = useStore.getState();
  useStore.setState({ reports: [...reports.filter((x) => x.id !== r.id), r] });
}

export function removeReport(id: string): void {
  useStore.setState({ reports: useStore.getState().reports.filter((x) => x.id !== id) });
}

export async function refreshReports(): Promise<void> {
  const { pack, pos } = useStore.getState();
  if (!pack || !pos || polling) return;
  polling = true;
  try {
    const ll = toLonLat(pack, pos);
    const reports = await reportsApi.near(ll.lon, ll.lat, POLL_RADIUS_M);
    useStore.setState({ reports });
    checkProximity();
  } catch (err) {
    console.warn('[reports] poll failed', err); // keep showing what we had
  } finally {
    polling = false;
  }
}

function checkProximity(): void {
  const { pack, pos, reports, nav } = useStore.getState();
  if (!pack || !pos) return;
  for (const r of reports) {
    if (warned.has(r.id)) continue;
    const at = toLocal(pack, { lon: r.lon, lat: r.lat });
    const d = dist(pos, at);
    if (d > WARN_RADIUS_M) continue;
    warned.add(r.id);
    const where = orientation.has ? `, ${relativeWords(angleDiff(orientation.heading, bearingENU(pos, at)))}` : '';
    const onRoute = nav?.reportIds.includes(r.id) ? ' It is on your route.' : '';
    // The "Heads up:" prefix is added by announce(); helpful features get a friendlier lead-in.
    const lead = HELPFUL_KINDS.includes(r.kind) ? 'good to know, ' : '';
    announce(
      `${lead}${REPORT_LABELS[r.kind]} reported ${metersPhrase(d)} away${where}. ${r.description}${onRoute}`,
      'Heads up',
      `(For vote_report: report_id ${r.id}. Do not read the id aloud.)`,
    );
  }
}

let stop: (() => void) | null = null;

export function startReportWatcher(): () => void {
  if (stop) return stop;
  void refreshReports();
  const timer = setInterval(() => void refreshReports(), POLL_MS);
  let lastFetchPos = useStore.getState().pos;
  const off = useStore.subscribe((s, prev) => {
    if (s.pos === prev.pos || !s.pos) return;
    checkProximity();
    // Moved a long way since the last fetch (teleport, fast walk): refresh right away.
    if (!lastFetchPos || dist(lastFetchPos, s.pos) > POLL_RADIUS_M / 2) {
      lastFetchPos = s.pos;
      void refreshReports();
    }
  });
  stop = () => {
    clearInterval(timer);
    off();
    stop = null;
  };
  return stop;
}
