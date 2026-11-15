// What the hazard check can tell apart, and what to tell the user for each: shared by the API (the choice question
// it asks the Decisions model) and the app (the spoken warning). Keep this file free of imports.

export const HAZARD_KINDS = {
  closed_door: 'A closed door directly in the path.',
  wall: 'A wall or solid barrier directly in the path.',
  glass: 'A glass door, glass wall or window in the path.',
  stairs_up: 'Stairs going up.',
  stairs_down: 'Stairs going down, or a drop with steps.',
  curb: 'A curb or single step up or down.',
  crosswalk: 'A crosswalk, or the edge of a street at a marked crossing.',
  street: 'The edge of a street or driveway with no marked crossing.',
  pole: 'A pole, post, sign, tree trunk or bollard.',
  person: 'A person or group of people in the path.',
  vehicle: 'A car, truck, bus or other vehicle.',
  bicycle: 'A bicycle, scooter or skateboard.',
  furniture: 'A bench, table, chair, planter or similar furniture.',
  low_obstacle: 'An object on the ground, such as a box, bag, cone or bin.',
  overhang: 'Something at head height, such as a branch, sign or low ceiling.',
  hole_or_drop: 'A hole, ditch, ledge or drop-off without steps.',
  other: 'Some other obstacle.',
} as const;

export type HazardKind = keyof typeof HAZARD_KINDS;

export const HAZARD_SIDES = {
  ahead: 'Straight ahead, in the middle of the image.',
  left: 'Ahead but toward the left side of the image.',
  right: 'Ahead but toward the right side of the image.',
} as const;

export type HazardSide = keyof typeof HAZARD_SIDES;

export type HazardResult = { hazard: boolean; probability: number; kind?: HazardKind; side?: HazardSide };

const WHERE: Record<HazardSide, string> = { ahead: 'straight ahead', left: 'ahead on your left', right: 'ahead on your right' };
/** Which way to step to get around something on that side. */
const AROUND: Record<HazardSide, string> = { ahead: 'to the left or right', left: 'to your right', right: 'to your left' };

/** One or two short sentences: what it is, where, and what to do. Relative directions only. */
export function hazardAdvice(kind: HazardKind = 'other', side: HazardSide = 'ahead'): string {
  const where = WHERE[side];
  const around = AROUND[side];
  switch (kind) {
    case 'closed_door':
      return `Closed door ${where}. Slow down and reach forward for the handle or push bar.`;
    case 'wall':
      return `Wall ${where}. Stop, then step ${around} to find a way around.`;
    case 'glass':
      return `Glass door or wall ${where}. Slow down and reach forward before you walk into it.`;
    case 'stairs_up':
      return `Stairs going up ${where}. Find the handrail and step up carefully.`;
    case 'stairs_down':
      return `Stairs going down ${where}. Stop, find the handrail, and feel for the first step.`;
    case 'curb':
      return `Curb ${where}. Slow down and feel for the edge with your foot or cane.`;
    case 'crosswalk':
      return `Crosswalk ${where}. Stop at the curb, listen, and cross straight when you don't hear any cars.`;
    case 'street':
      return `Street ${where} with no crosswalk. Stop at the curb, and only cross when you hear no traffic, or find a crosswalk.`;
    case 'pole':
      return `Pole ${where}. Step ${around} to go around it.`;
    case 'person':
      return `Person ${where}. Slow down, or step ${around}.`;
    case 'vehicle':
      return `Vehicle ${where}. Stop and wait until you hear it move away.`;
    case 'bicycle':
      return `Bike or scooter ${where}. Stop and let it pass.`;
    case 'furniture':
      return `Bench or table ${where}. Step ${around} to go around it.`;
    case 'low_obstacle':
      return `Something on the ground ${where}. Step ${around} to go around it.`;
    case 'overhang':
      return `Something at head height ${where}. Duck, or step ${around}.`;
    case 'hole_or_drop':
      return `Drop or hole ${where}. Stop, and step ${around} away from the edge.`;
    default:
      return `Obstacle ${where}. Slow down and step ${around}.`;
  }
}
