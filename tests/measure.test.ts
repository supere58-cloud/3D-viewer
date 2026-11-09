import { describe, expect, it } from 'vitest';
import { measure } from '../src/ui/measure';
import { pickPoints, pickSegments } from '../src/viewer/pick';

describe('measurement', () => {
  it('computes distances, azimuth and dip', () => {
    const m = measure([654321, 7654321, 100], [654324, 7654325, 88]);
    expect(m.dh).toBeCloseTo(5, 9);
    expect(m.dz).toBe(-12);
    expect(m.d3).toBeCloseTo(13, 9);
    expect(m.azimuth).toBeCloseTo(36.8699, 3);
    expect(m.dip).toBeCloseTo(-67.3801, 3);
  });
  it('uses compass azimuths', () => {
    expect(measure([0, 0, 0], [0, 1, 0]).azimuth).toBeCloseTo(0);
    expect(measure([0, 0, 0], [1, 0, 0]).azimuth).toBeCloseTo(90);
    expect(measure([0, 0, 0], [0, -1, 0]).azimuth).toBeCloseTo(180);
    expect(measure([0, 0, 0], [-1, 0, 0]).azimuth).toBeCloseTo(270);
    expect(measure([0, 0, 0], [0, 0, 5]).dip).toBeCloseTo(90);
    expect(measure([0, 0, 0], [0, 0, 0]).d3).toBe(0);
  });
});

describe('screen-space picking', () => {
  // Orthographic-style matrix: x,y in [-1,1] map straight to the 200x200 viewport.
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  it('finds the closest point on a segment', () => {
    const seg = new Float32Array([-0.5, 0, 0, 0.5, 0, 0]);
    const hit = pickSegments(seg, I, 200, 200, 110, 104, 10, 5)!;
    expect(hit.vertex).toBe(false);
    expect(hit.x).toBeCloseTo(0.1, 5);
    expect(hit.px).toBeCloseTo(4, 5);
    expect(pickSegments(seg, I, 200, 200, 110, 130, 10, 5)).toBeNull();
  });
  it('snaps to a segment end', () => {
    const seg = new Float32Array([-0.5, 0, 0, 0.5, 0, 0]);
    const hit = pickSegments(seg, I, 200, 200, 147, 101, 10, 5)!;
    expect(hit.vertex).toBe(true);
    expect(hit.x).toBe(0.5);
  });
  it('ignores geometry behind the eye', () => {
    const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]; // w = -z
    expect(pickSegments(new Float32Array([0, 0, 1, 0, 0, 2]), behind, 200, 200, 100, 100, 10, 5)).toBeNull();
    expect(pickPoints(new Float32Array([0, 0, 1]), behind, 200, 200, 100, 100, 10)).toBeNull();
  });
  it('picks the nearest point', () => {
    const pts = new Float32Array([0, 0, 0, 0.1, 0, 0, 0.9, 0.9, 0]);
    const hit = pickPoints(pts, I, 200, 200, 109, 100, 10)!;
    expect(hit.x).toBeCloseTo(0.1, 6);
  });
});
