// The agent's system instruction and tool declarations.
// The server locks these into each ephemeral token; the client only executes the tools.
// Keep this file free of imports (it is loaded by both the browser bundle and the Node API).

import { REPORT_KINDS } from './reports';

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';
/** Ephemeral tokens for the Live API are served from this API version. */
export const LIVE_API_VERSION = 'v1beta';

export const SYSTEM_INSTRUCTION = `You are Wayfinder, a calm, concise guide for blind and low-vision people on the UMass Amherst campus. You speak through their phone, and you can see through its camera when camera mode is on.

How to speak:
- Keep each turn under about two sentences unless the user asks for more.
- Lead with what matters for safety: steps, doors, obstacles, vehicles, people directly ahead.
- Give directions as clock-face positions and a distance, for example "bench at your 2 o'clock, about 15 feet". Twelve o'clock is straight ahead of the phone.
- Units: tools return distances already written in the user's unit (feet by default, or meters). Repeat them as given and never convert. When you estimate a distance from the camera yourself, use the same unit; get_context reports it as "units".
- Never use phrases that depend on sight, like "over there" or "as you can see".

Facts about places:
- Never invent locations, distances or directions. Use tools for anything about places, distances, directions, routes or community reports. If a tool finds nothing, say so.
- Use get_context when you need to know where the user is or which way they face.
- Before starting navigation, confirm the destination in one short question, then call start_navigation once the user agrees. After it starts, read only the first instruction; the app announces later turns.
- The app plays ticking sounds that speed up as the user turns away from the right direction and go quiet when they face it. Mention this once when guidance starts.

Messages from the app:
- Text beginning "Navigation update:" or "Heads up:" comes from the app, not the user. Say its content to the user right away, briefly, in your own voice. Never say the words "Navigation update" or "Heads up" themselves, and do not answer it as if the user had spoken.
- Text beginning "App note:" is silent context for you. Do not read it aloud.

Community reports:
- Users can report accessibility problems (construction, blocked sidewalk, broken elevator, wet floor, obstacle) and helpful features (automatic door, ramp, curb cut). When the user describes one, call report_hazard with a short description.
- If the camera clearly shows something that blocks a walking path, ask "Do you want me to mark this for others?" and report it only if the user says yes.
- When the app says the user is near a report, you may ask whether it is still there and call vote_report with their answer.

Views:
- "X-ray" mode turns the camera off and shows a wireframe map. In x-ray mode you cannot see; rely on tools such as describe_xray_view.
- Switch views with set_mode when asked.

If you cannot see clearly or are unsure, say so plainly instead of guessing.`;

type Schema = {
  type: 'OBJECT' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN';
  description?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
};

export type ToolDeclaration = {
  name: string;
  description: string;
  parameters?: Schema;
};

export const FEATURE_KINDS = ['bench', 'trash', 'bike_parking', 'water', 'toilets', 'bus_stop', 'entrance'] as const;

const placeArgs: Record<string, Schema> = {
  place_id: { type: 'STRING', description: 'A place_id returned by find_place, find_nearby or get_reports_nearby.' },
  lon: { type: 'NUMBER', description: 'Longitude, only if there is no place_id.' },
  lat: { type: 'NUMBER', description: 'Latitude, only if there is no place_id.' },
};

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'get_context',
    description:
      'Current position estimate and its accuracy, whether the user is indoors, the building they are in, which way they face, and the active route if any.',
  },
  {
    name: 'find_place',
    description:
      'Search campus buildings and named places by name or nickname (for example "CS Labs", "ILC", "the library"). Returns up to 3 matches with distance and clock-face direction.',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: 'The place name as the user said it.' } },
      required: ['query'],
    },
  },
  {
    name: 'find_nearby',
    description: 'Nearest small features of one kind (bench, trash can, bike parking, water, toilets, bus stop, entrance) with distance and clock-face direction.',
    parameters: {
      type: 'OBJECT',
      properties: {
        kind: { type: 'STRING', enum: [...FEATURE_KINDS] },
        limit: { type: 'INTEGER', description: 'How many to return (default 3, max 5).' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'start_navigation',
    description:
      'Start turn-by-turn walking navigation to a place. Call only after the user confirmed the destination. Returns the first steps and total distance and time.',
    parameters: {
      type: 'OBJECT',
      properties: { ...placeArgs, label: { type: 'STRING', description: 'Spoken name of the destination.' } },
      required: ['label'],
    },
  },
  {
    name: 'point_to',
    description: 'Bearing-only guidance toward a nearby target with no route: the ticking sound guides the user to face it.',
    parameters: {
      type: 'OBJECT',
      properties: { ...placeArgs, label: { type: 'STRING', description: 'Spoken name of the target.' } },
    },
  },
  { name: 'stop_navigation', description: 'Stop navigation and bearing guidance.' },
  {
    name: 'set_mode',
    description: 'Switch the screen between the live camera and the x-ray wireframe map.',
    parameters: {
      type: 'OBJECT',
      properties: { mode: { type: 'STRING', enum: ['camera', 'xray'] } },
      required: ['mode'],
    },
  },
  {
    name: 'report_hazard',
    description: 'Create a community accessibility report at the user\'s current position, shared with other users.',
    parameters: {
      type: 'OBJECT',
      properties: {
        kind: { type: 'STRING', enum: [...REPORT_KINDS] },
        description: { type: 'STRING', description: 'One short sentence describing it, for other blind users.' },
        permanent: { type: 'BOOLEAN', description: 'True for lasting features (automatic door, ramp, curb cut, stairs only).' },
        source: { type: 'STRING', enum: ['voice', 'camera'], description: 'voice if the user described it, camera if you saw it.' },
      },
      required: ['kind', 'description'],
    },
  },
  {
    name: 'get_reports_nearby',
    description: 'Active community accessibility reports near the user, with distance and clock-face direction.',
    parameters: {
      type: 'OBJECT',
      properties: { radius_m: { type: 'NUMBER', description: 'Search radius in meters (default 60, max 300).' } },
    },
  },
  {
    name: 'vote_report',
    description: 'Record whether a reported problem is still there (confirm) or gone (resolve).',
    parameters: {
      type: 'OBJECT',
      properties: {
        report_id: { type: 'STRING' },
        still_there: { type: 'BOOLEAN' },
      },
      required: ['report_id', 'still_there'],
    },
  },
  {
    name: 'describe_xray_view',
    description: 'Lists what the x-ray view shows in the direction the phone faces (within 35 degrees either side, up to 80 meters): buildings, features, reports and the target.',
  },
];
