// Tiny typed event bus between sensor sources (real or simulated) and their consumers.

export type GpsFix = {
  lon: number;
  lat: number;
  accuracy: number;
  /** When the fix was taken (epoch ms; may be a little before it arrives). */
  time: number;
  /** Ground speed m/s and course degrees from north, when the phone reports them (only while moving). */
  speed?: number | null;
  heading?: number | null;
};

type Events = {
  gps: GpsFix;
  /** One detected footstep. */
  step: { time: number };
  /** The position was set by hand (dev simulator): forget the filter state. */
  teleport: { lon: number; lat: number };
};

type Handler<K extends keyof Events> = (payload: Events[K]) => void;
const handlers: { [K in keyof Events]: Set<Handler<K>> } = { gps: new Set(), step: new Set(), teleport: new Set() };

export function on<K extends keyof Events>(event: K, handler: Handler<K>): () => void {
  handlers[event].add(handler);
  return () => handlers[event].delete(handler);
}

export function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
  for (const h of handlers[event]) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[bus] ${event} handler failed`, err);
    }
  }
}
