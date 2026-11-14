// The campus data pack format (public/data/campus.json), produced by scripts/build-campus-pack.ts.

export type LL = [lon: number, lat: number];

export type WayKind = 'footway' | 'sidewalk' | 'path' | 'steps' | 'road' | 'crossing';
export type FeatureKind =
  | 'bench'
  | 'trash'
  | 'bike_parking'
  | 'water'
  | 'toilets'
  | 'bus_stop'
  | 'entrance'
  | 'picnic_table'
  | 'tree';

export type PackBuilding = {
  id: string;
  name?: string;
  altNames?: string[];
  heightM: number;
  outer: LL[];
  holes?: LL[][];
};

export type PackWay = { id: string; kind: WayKind; coords: LL[] };

export type PackFeature = {
  id: string;
  kind: FeatureKind;
  lon: number;
  lat: number;
  name?: string;
  /** Position projected beside the nearest sidewalk/footway/path. */
  snapped?: { lon: number; lat: number; wayId: string };
  /** For entrances: the building whose wall the door is on. */
  buildingId?: string;
};

export type GazetteerEntry = {
  name: string;
  aliases: string[];
  lon: number;
  lat: number;
  kind: string;
  buildingId?: string;
};

export type CampusPack = {
  origin: { lat: number; lon: number };
  buildings: PackBuilding[];
  ways: PackWay[];
  features: PackFeature[];
  gazetteer: GazetteerEntry[];
};
