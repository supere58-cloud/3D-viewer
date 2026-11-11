import { describe, expect, it } from 'vitest';
import { azimuthBetween, changeThickness, moveSlice, nearestThickness, sliceNormal, type Slice } from '../src/ui/slices';
import { pickPoints, pickSegments } from '../src/viewer/pick';

const slice = (over: Partial<Slice>): Slice => ({ id: 's', kind: 'v', point: [100, 200, 50], azimuth: 0, thickness: 10, ...over });

describe('slices', () => {
  it('has a vertical normal for a level plan and a horizontal one for a vertical section', () => {
    expect(sliceNormal(slice({ kind: 'h' }))).toEqual([0, 0, 1]);
    const n = sliceNormal(slice({ azimuth: 0 })); // section line runs north: plane normal points east
    expect(n[0]).toBeCloseTo(1); expect(n[1]).toBeCloseTo(0); expect(n[2]).toBe(0);
    const e = sliceNormal(slice({ azimuth: 90 })); // line runs east: normal points south
    expect(e[0]).toBeCloseTo(0); expect(e[1]).toBeCloseTo(-1);
  });
  it('contains both points it was made from', () => {
    const a: [number, number, number] = [654300, 7654300, 10], b: [number, number, number] = [654340, 7654330, -20];
    const az = azimuthBetween(a, b)!;
    const n = sliceNormal(slice({ azimuth: az, point: a }));
    expect(n[0] * (b[0] - a[0]) + n[1] * (b[1] - a[1])).toBeCloseTo(0, 9);
    expect(azimuthBetween(a, [a[0], a[1], 99])).toBeNull();
    expect(azimuthBetween(b, a)).toBeCloseTo(az, 9);
  });
  it('pages by its own thickness and steps through the thickness list', () => {
    const s = slice({ kind: 'h', thickness: 10 });
    moveSlice(s, 2);
    expect(s.point).toEqual([100, 200, 70]);
    changeThickness(s, 1);
    expect(s.thickness).toBe(20);
    changeThickness(s, -1); changeThickness(s, -1);
    expect(s.thickness).toBe(5);
    expect(nearestThickness(37)).toBe(50);
  });
  it('picking ignores what the slice hides', () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const slab = { nx: 0, ny: 0, nz: 1, c: 0, half: 0.1 };
    // Two points on top of each other on screen; only the one inside the slab may be picked.
    const pts = new Float32Array([0, 0, 0.5, 0, 0, 0.05]);
    expect(pickPoints(pts, I, 200, 200, 100, 100, 10)!.z).toBeCloseTo(0.5);
    expect(pickPoints(pts, I, 200, 200, 100, 100, 10, slab)!.z).toBeCloseTo(0.05);
    const seg = new Float32Array([-0.5, 0, 0.5, 0.5, 0, 0.5]);
    expect(pickSegments(seg, I, 200, 200, 100, 100, 10, 5)).not.toBeNull();
    expect(pickSegments(seg, I, 200, 200, 100, 100, 10, 5, slab)).toBeNull();
  });
});
