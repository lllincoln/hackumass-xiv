import { describe, expect, it } from 'vitest';
import { elevationIn, indexTerrain, type TerrainFile } from './terrain';

/** A 3×3 grid at 10 m: rising 1 m per cell eastward, 2 m per cell northward, from 50 m at the SW corner. */
function file(): { raw: TerrainFile; bin: ArrayBuffer } {
  const dm = new Int16Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) dm[r * 3 + c] = (50 + c + 2 * r) * 10;
  return {
    raw: { source: 'test', cellM: 10, x0: -10, y0: -10, cols: 3, rows: 3, heightsFile: 'test.bin', contours: [{ e: 51, i: 1, p: [0, 0, 5, 5] }] },
    bin: dm.buffer,
  };
}

function load() {
  const { raw, bin } = file();
  return indexTerrain(raw, bin);
}

describe('terrain', () => {
  it('decodes the grid and measures heights from the origin', () => {
    const t = load();
    expect(t.heights[0]).toBeCloseTo(50);
    expect(t.heights[8]).toBeCloseTo(56);
    // origin (0, 0) is grid cell (1, 1): 50 + 1 + 2
    expect(t.ref).toBeCloseTo(53);
    expect(t.contours[0]).toMatchObject({ elev: 51, index: true, minX: 0, maxX: 5 });
  });

  it('interpolates a plane exactly on both triangles of a cell', () => {
    const t = load();
    // A plane is reproduced exactly by either triangle: 50 + x/10 + 2y/10 relative to the SW corner.
    const expected = (x: number, y: number) => 50 + (x + 10) / 10 + (2 * (y + 10)) / 10;
    for (const [x, y] of [[-7, -8], [-2, -1], [4, 3], [9, 1], [0, 0], [10, 10]]) {
      expect(elevationIn(t, { x, y })).toBeCloseTo(expected(x, y));
    }
    expect(elevationIn(t, { x: 11, y: 0 })).toBeNull();
  });
});
