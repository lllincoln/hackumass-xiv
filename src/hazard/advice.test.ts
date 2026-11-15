import { describe, expect, it } from 'vitest';
import { HAZARD_KINDS, hazardAdvice } from '../../shared/hazards';

describe('hazard advice', () => {
  it('says what it is, where, and what to do', () => {
    expect(hazardAdvice('crosswalk', 'ahead')).toBe(
      "Crosswalk straight ahead. Stop at the curb, listen, and cross straight when you don't hear any cars.",
    );
    expect(hazardAdvice('closed_door', 'ahead')).toMatch(/^Closed door straight ahead\. .*handle/);
  });

  it('steps away from the side the obstacle is on', () => {
    expect(hazardAdvice('pole', 'left')).toBe('Pole ahead on your left. Step to your right to go around it.');
    expect(hazardAdvice('pole', 'right')).toContain('Step to your left');
  });

  it('has advice for every kind, in relative directions only', () => {
    for (const kind of Object.keys(HAZARD_KINDS) as (keyof typeof HAZARD_KINDS)[]) {
      const text = hazardAdvice(kind, 'right');
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/north|south|east|west|o'clock/i);
    }
  });
});
