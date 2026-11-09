import type { Vec3 } from '../core/types';

export interface Measurement {
  /** Straight-line distance. */
  d3: number;
  /** Distance in plan. */
  dh: number;
  /** Z of the second point minus Z of the first. */
  dz: number;
  /** Bearing from the first point to the second, degrees clockwise from north, 0..360. */
  azimuth: number;
  /** Inclination of the line, degrees; negative when the second point is lower. */
  dip: number;
}

export function measure(a: Vec3, b: Vec3): Measurement {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const dh = Math.hypot(dx, dy);
  let azimuth = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (azimuth < 0) azimuth += 360;
  if (dh === 0) azimuth = 0;
  return {
    d3: Math.hypot(dx, dy, dz),
    dh,
    dz,
    azimuth,
    dip: dh === 0 && dz === 0 ? 0 : (Math.atan2(dz, dh) * 180) / Math.PI,
  };
}
