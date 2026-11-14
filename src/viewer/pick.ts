/**
 * Screen-space picking for line segments and points. Runs only on a tap, so a
 * plain loop over the buffers is fast enough (about 10 ms per million
 * segments) and needs no extra index memory.
 */

/** A slab |n.p - c| <= half in the same local coordinates as the positions; hits outside are ignored. */
export interface Slab { nx: number; ny: number; nz: number; c: number; half: number }

export interface ScreenHit {
  /** Distance from the tap in CSS pixels. */
  px: number;
  /** Position in the object's local coordinates. */
  x: number; y: number; z: number;
  /** True when the hit is exactly a stored vertex. */
  vertex: boolean;
  /** For a line hit: both ends of the segment, local coordinates (ax, ay, az, bx, by, bz). */
  seg?: [number, number, number, number, number, number];
}

const EPS_W = 1e-6;

/**
 * mvp: column-major 4x4 (three.js Matrix4.elements) mapping local to clip space.
 * Returns the closest segment within `radius` pixels of (tapX, tapY), or null.
 */
export function pickSegments(
  pos: Float32Array, mvp: ArrayLike<number>, width: number, height: number,
  tapX: number, tapY: number, radius: number, snapRadius: number, slab: Slab | null = null,
): ScreenHit | null {
  const m0 = mvp[0], m1 = mvp[1], m3 = mvp[3], m4 = mvp[4], m5 = mvp[5], m7 = mvp[7];
  const m8 = mvp[8], m9 = mvp[9], m11 = mvp[11], m12 = mvp[12], m13 = mvp[13], m15 = mvp[15];
  const hw = width / 2, hh = height / 2;
  let best = radius * radius;
  let bestI = -1, bestT = 0;
  for (let i = 0; i + 5 < pos.length; i += 6) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    let aw = m3 * ax + m7 * ay + m11 * az + m15;
    let bw = m3 * bx + m7 * by + m11 * bz + m15;
    if (aw < EPS_W && bw < EPS_W) continue;
    let acx = m0 * ax + m4 * ay + m8 * az + m12, acy = m1 * ax + m5 * ay + m9 * az + m13;
    let bcx = m0 * bx + m4 * by + m8 * bz + m12, bcy = m1 * bx + m5 * by + m9 * bz + m13;
    // Clip the part behind the eye; t0..t1 is the visible parameter range.
    let t0 = 0, t1 = 1;
    if (aw < EPS_W) {
      t0 = (EPS_W - aw) / (bw - aw);
      acx += (bcx - acx) * t0; acy += (bcy - acy) * t0; aw = EPS_W;
    } else if (bw < EPS_W) {
      t1 = (EPS_W - aw) / (bw - aw);
      bcx = acx + (bcx - acx) * t1; bcy = acy + (bcy - acy) * t1; bw = EPS_W;
    }
    const sax = (acx / aw + 1) * hw, say = (1 - acy / aw) * hh;
    const sbx = (bcx / bw + 1) * hw, sby = (1 - bcy / bw) * hh;
    if ((sax < tapX - radius && sbx < tapX - radius) || (sax > tapX + radius && sbx > tapX + radius)) continue;
    if ((say < tapY - radius && sby < tapY - radius) || (say > tapY + radius && sby > tapY + radius)) continue;
    const dx = sbx - sax, dy = sby - say;
    const len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? ((tapX - sax) * dx + (tapY - say) * dy) / len2 : 0;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    const ex = sax + dx * u - tapX, ey = say + dy * u - tapY;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) {
      // Screen-space parameter to perspective-correct parameter.
      const denom = (1 - u) * bw + u * aw;
      const t = t0 + (t1 - t0) * (denom > 0 ? (u * aw) / denom : u);
      if (slab) {
        const d = slab.nx * (ax + (bx - ax) * t) + slab.ny * (ay + (by - ay) * t) + slab.nz * (az + (bz - az) * t) - slab.c;
        if (d > slab.half || d < -slab.half) continue;
      }
      best = d2;
      bestI = i;
      bestT = t;
    }
  }
  if (bestI < 0) return null;
  const i = bestI;
  let t = bestT;
  let vertex = false;
  // Snap to an end of the segment when the tap is close to it on screen.
  const project = (x: number, y: number, z: number): number => {
    const w = m3 * x + m7 * y + m11 * z + m15;
    if (w < EPS_W) return Infinity;
    const sx = ((m0 * x + m4 * y + m8 * z + m12) / w + 1) * hw, sy = (1 - (m1 * x + m5 * y + m9 * z + m13) / w) * hh;
    return Math.hypot(sx - tapX, sy - tapY);
  };
  const da = project(pos[i], pos[i + 1], pos[i + 2]);
  const db = project(pos[i + 3], pos[i + 4], pos[i + 5]);
  let px = Math.sqrt(best);
  if (Math.min(da, db) <= snapRadius) {
    const end = da <= db ? 0 : 3;
    const d = slab ? slab.nx * pos[i + end] + slab.ny * pos[i + end + 1] + slab.nz * pos[i + end + 2] - slab.c : 0;
    // Only snap to an end that is itself inside the slice.
    if (!slab || (d <= slab.half && d >= -slab.half)) {
      vertex = true;
      t = end === 0 ? 0 : 1;
      px = Math.min(da, db);
    }
  }
  return {
    px, vertex,
    seg: [pos[i], pos[i + 1], pos[i + 2], pos[i + 3], pos[i + 4], pos[i + 5]],
    x: pos[i] + (pos[i + 3] - pos[i]) * t,
    y: pos[i + 1] + (pos[i + 4] - pos[i + 1]) * t,
    z: pos[i + 2] + (pos[i + 5] - pos[i + 2]) * t,
  };
}

/** Closest vertex of `pos` (xyz triples) within `radius` pixels, or null. */
export function pickPoints(
  pos: Float32Array, mvp: ArrayLike<number>, width: number, height: number,
  tapX: number, tapY: number, radius: number, slab: Slab | null = null,
): ScreenHit | null {
  const m0 = mvp[0], m1 = mvp[1], m3 = mvp[3], m4 = mvp[4], m5 = mvp[5], m7 = mvp[7];
  const m8 = mvp[8], m9 = mvp[9], m11 = mvp[11], m12 = mvp[12], m13 = mvp[13], m15 = mvp[15];
  const hw = width / 2, hh = height / 2;
  let best = radius * radius;
  let bestI = -1;
  for (let i = 0; i + 2 < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const w = m3 * x + m7 * y + m11 * z + m15;
    if (w < EPS_W) continue;
    const ex = ((m0 * x + m4 * y + m8 * z + m12) / w + 1) * hw - tapX;
    const ey = (1 - (m1 * x + m5 * y + m9 * z + m13) / w) * hh - tapY;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) {
      if (slab) {
        const d = slab.nx * x + slab.ny * y + slab.nz * z - slab.c;
        if (d > slab.half || d < -slab.half) continue;
      }
      best = d2;
      bestI = i;
    }
  }
  if (bestI < 0) return null;
  return { px: Math.sqrt(best), vertex: true, x: pos[bestI], y: pos[bestI + 1], z: pos[bestI + 2] };
}
