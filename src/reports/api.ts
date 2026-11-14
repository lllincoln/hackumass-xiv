// Client for the community reports API (MongoDB Atlas behind /api).

import type { CreateReportBody, ReportDTO } from '../../shared/reports';
import type { LL } from '../data/types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`reports API: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

export const reportsApi = {
  async near(lon: number, lat: number, radiusM: number): Promise<ReportDTO[]> {
    const q = new URLSearchParams({ lon: lon.toFixed(6), lat: lat.toFixed(6), radius: String(Math.round(radiusM)) });
    const res = await fetch(`/api/reports?${q}`, { signal: AbortSignal.timeout(8000) });
    return (await json<{ reports: ReportDTO[] }>(res)).reports;
  },

  async alongRoute(coords: LL[]): Promise<ReportDTO[]> {
    const res = await post('/api/reports/along-route', { type: 'LineString', coordinates: coords });
    return (await json<{ reports: ReportDTO[] }>(res)).reports;
  },

  async create(body: CreateReportBody): Promise<{ report: ReportDTO; merged: boolean }> {
    return json(await post('/api/reports', body));
  },

  async confirm(id: string): Promise<{ report: ReportDTO }> {
    return json(await post(`/api/reports/${encodeURIComponent(id)}/confirm`));
  },

  async resolve(id: string): Promise<{ report?: ReportDTO; deleted?: boolean }> {
    return json(await post(`/api/reports/${encodeURIComponent(id)}/resolve`));
  },
};
