// Shared between the API (server/) and the client (src/). Keep this file free of imports.

export const REPORT_KINDS = [
  'construction',
  'blocked_sidewalk',
  'broken_elevator',
  'wet_floor',
  'obstacle',
  'auto_door',
  'ramp',
  'curb_cut',
  'stairs_only',
  'other',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Kinds that describe the built environment and never expire. */
export const PERMANENT_KINDS: readonly ReportKind[] = ['auto_door', 'ramp', 'curb_cut', 'stairs_only'];
/** Kinds that make a route impassable, so navigation tries an alternative. */
export const BLOCKING_KINDS: readonly ReportKind[] = ['construction', 'blocked_sidewalk'];
/** Kinds that help rather than warn (drawn green). */
export const HELPFUL_KINDS: readonly ReportKind[] = ['auto_door', 'ramp', 'curb_cut'];

export const REPORT_LABELS: Record<ReportKind, string> = {
  construction: 'construction',
  blocked_sidewalk: 'blocked sidewalk',
  broken_elevator: 'broken elevator',
  wet_floor: 'wet floor',
  obstacle: 'obstacle',
  auto_door: 'automatic door',
  ramp: 'ramp',
  curb_cut: 'curb cut',
  stairs_only: 'stairs only, no ramp',
  other: 'accessibility note',
};

export type ReportSource = 'voice' | 'camera' | 'manual';

export const DEFAULT_TTL_HOURS = 48;
export const CONFIRM_EXTEND_HOURS = 24;
export const RESOLUTIONS_TO_DELETE = 3;
export const ROUTE_BUFFER_M = 15;

/** Wire format returned by the API. */
export type ReportDTO = {
  id: string;
  kind: ReportKind;
  lon: number;
  lat: number;
  description: string;
  source: ReportSource;
  permanent: boolean;
  confirmations: number;
  resolutions: number;
  createdAt: string;
  lastConfirmedAt: string;
  expiresAt?: string;
  building?: string;
  floor?: number;
  distanceM?: number;
};

export type CreateReportBody = {
  kind: ReportKind;
  lon: number;
  lat: number;
  description: string;
  source?: ReportSource;
  permanent?: boolean;
  building?: string;
  floor?: number;
};
