/** Sections ("slices"): a plane with a thickness; only the slab around it is shown. */
import type { Vec3 } from '../core/types';
import type { SlicePlane } from '../viewer/viewer';

export interface Slice {
  id: string;
  /** 'h' = horizontal (a level plan), 'v' = vertical along a line. */
  kind: 'h' | 'v';
  /** A point on the plane, true coordinates. */
  point: Vec3;
  /** Vertical only: bearing of the section line, degrees clockwise from north, 0..180. */
  azimuth: number;
  /** Width of the visible slab, metres. */
  thickness: number;
  /** Half the length of the line the section was made from, for framing the view; absent otherwise. */
  halfLength?: number;
}

export const THICKNESSES = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];

/** Unit normal of the slice plane. For a vertical slice it is horizontal, 90 degrees right of the section line. */
export function sliceNormal(s: Slice): Vec3 {
  if (s.kind === 'h') return [0, 0, 1];
  const a = (s.azimuth * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a), 0];
}

export function slicePlane(s: Slice): SlicePlane {
  return { normal: sliceNormal(s), point: s.point, thickness: s.thickness };
}

/** Moves the slice along its normal by whole thicknesses (the usual way to page through sections). */
export function moveSlice(s: Slice, steps: number): void {
  const n = sliceNormal(s);
  const d = steps * s.thickness;
  s.point = [s.point[0] + n[0] * d, s.point[1] + n[1] * d, s.point[2] + n[2] * d];
}

export function changeThickness(s: Slice, dir: 1 | -1): void {
  let i = 0;
  for (let k = 0; k < THICKNESSES.length; k++) if (Math.abs(THICKNESSES[k] - s.thickness) < Math.abs(THICKNESSES[i] - s.thickness)) i = k;
  s.thickness = THICKNESSES[Math.max(0, Math.min(THICKNESSES.length - 1, i + dir))];
}

/** Thickness from the list closest to `value`. */
export function nearestThickness(value: number): number {
  return THICKNESSES.reduce((best, t) => (Math.abs(t - value) < Math.abs(best - value) ? t : best), THICKNESSES[0]);
}

/**
 * A vertical slice along the line a -> b (for example two points tapped on an
 * existing string), or null when the points are on one vertical.
 */
export function azimuthBetween(a: Vec3, b: Vec3): number | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < 1e-6) return null;
  let az = (Math.atan2(dx, dy) * 180) / Math.PI;
  // A line and its reverse are the same section.
  az = ((az % 180) + 180) % 180;
  return az;
}
