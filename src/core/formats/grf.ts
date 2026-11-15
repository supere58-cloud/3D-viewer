/**
 * Micromine image georeference (.grf): where a picture sits in 3D.
 *
 * Layout, one number per line:
 *   1-3   world position of the picture's top-left corner
 *   4-5   size of one pixel along the picture's X and Y, metres
 *   6-8   unit vector of the picture's X axis (to the right)
 *   9-11  unit vector of the picture's "up" axis
 * followed by control-point lines "px py X Y Z flag", which are not needed
 * to place the picture and are only used here as a sanity check.
 *
 * A pixel (px, py), with py counted downwards, is at
 *   origin + xAxis * px * pixelX - upAxis * py * pixelY.
 */
import type { Vec3 } from '../types';

export interface Georef {
  origin: Vec3;
  pixelX: number;
  pixelY: number;
  xAxis: Vec3;
  upAxis: Vec3;
}

export function parseGrf(text: string): Georef | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 11) return null;
  const n: number[] = [];
  for (let i = 0; i < 11; i++) {
    // The header has exactly one number per line.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(lines[i])) return null;
    n.push(Number(lines[i]));
  }
  const xAxis: Vec3 = [n[5], n[6], n[7]], upAxis: Vec3 = [n[8], n[9], n[10]];
  const lx = Math.hypot(...xAxis), lu = Math.hypot(...upAxis);
  // Reject files that only look like a georeference: bad pixel size or axes that are not unit vectors.
  if (!(n[3] > 0) || !(n[4] > 0) || Math.abs(lx - 1) > 0.05 || Math.abs(lu - 1) > 0.05) return null;
  return { origin: [n[0], n[1], n[2]], pixelX: n[3], pixelY: n[4], xAxis, upAxis };
}

/** World position of a pixel. */
export function pixelToWorld(g: Georef, px: number, py: number): Vec3 {
  const a = px * g.pixelX, b = py * g.pixelY;
  return [
    g.origin[0] + g.xAxis[0] * a - g.upAxis[0] * b,
    g.origin[1] + g.xAxis[1] * a - g.upAxis[1] * b,
    g.origin[2] + g.xAxis[2] * a - g.upAxis[2] * b,
  ];
}

/** The picture's four corners: top-left, top-right, bottom-right, bottom-left. */
export function imageCorners(g: Georef, width: number, height: number): [Vec3, Vec3, Vec3, Vec3] {
  return [pixelToWorld(g, 0, 0), pixelToWorld(g, width, 0), pixelToWorld(g, width, height), pixelToWorld(g, 0, height)];
}

/**
 * Pixel size of a JPEG or PNG read from its first bytes, without decoding
 * the picture (scans can be hundreds of megapixels). Null if not recognised.
 */
export function imageSize(head: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length >= 24 && dv.getUint32(0) === 0x89504e47 && dv.getUint32(4) === 0x0d0a1a0a) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < head.length) {
    if (head[i] !== 0xff) { i++; continue; }
    const marker = head[i + 1];
    if (marker === 0xff) { i++; continue; }
    // Start-of-frame markers carry the size; C4, C8 and CC are other tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    i += 2 + dv.getUint16(i + 2);
  }
  return null;
}

export function isImageName(name: string): boolean {
  return /\.(jpe?g|png)$/i.test(name);
}

/** File name without its extension, lower-cased: how a picture and its .grf are matched. */
export function pairKey(name: string): string {
  return name.replace(/\.[^.]*$/, '').toLowerCase();
}
