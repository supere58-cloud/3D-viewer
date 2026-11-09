/**
 * Accumulates primitives per layer and turns them into float32 buffers that
 * are relative to one float64 origin per file.
 *
 * Streaming means the extent of the file is unknown while reading, and real
 * exports often contain stray entities near 0,0 next to a model at 7-digit
 * coordinates. So primitives are first binned into 16 km tiles, each stored as
 * float32 offsets from its own tile centre (exact to about half a millimetre).
 * When the file ends, the tile holding most of the geometry gives the file
 * origin and the other tiles are re-based onto it. Only geometry far away
 * from the main model can lose precision, and that case is reported.
 */
import type { GeometrySink, LayerDef, ParsedLabels, ParsedLayer, PrimitiveSet, Vec3 } from '../types';
import { FALLBACK_PALETTE } from '../dxf/aci';

const CHUNK = 9 * 65536; // floats; divisible by 9, 6 and 3
const TILE = 16384; // metres
const INV_TILE = 1 / TILE;
/** Tiles further than this many cells from the main one are "far outliers". */
const FOCUS_CELLS = 4;

class FloatChunks {
  private chunks: Float32Array[] = [];
  private cur: Float32Array = new Float32Array(0);
  private at = 0;
  length = 0;

  push3(a: number, b: number, c: number): void {
    if (this.at === this.cur.length) {
      this.cur = new Float32Array(CHUNK);
      this.chunks.push(this.cur);
      this.at = 0;
    }
    const cur = this.cur;
    cur[this.at] = a; cur[this.at + 1] = b; cur[this.at + 2] = c;
    this.at += 3;
    this.length += 3;
  }

  /** Copies into dst at offset (adding a re-base shift) and releases the chunks. */
  drain(dst: Float32Array, offset: number, dx: number, dy: number, dz: number): void {
    let off = offset;
    let left = this.length;
    const shift = dx !== 0 || dy !== 0 || dz !== 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const n = Math.min(c.length, left);
      if (shift) {
        for (let k = 0; k < n; k += 3) {
          dst[off + k] = c[k] + dx; dst[off + k + 1] = c[k + 1] + dy; dst[off + k + 2] = c[k + 2] + dz;
        }
      } else {
        dst.set(n === c.length ? c : c.subarray(0, n), off);
      }
      off += n;
      left -= n;
      this.chunks[i] = new Float32Array(0);
    }
    this.chunks = [];
    this.cur = new Float32Array(0);
    this.at = 0;
    this.length = 0;
  }
}

/** One primitive kind of one layer in one tile. Colours are stored only when mixed. */
class Bucket {
  pos = new FloatChunks();
  count = 0;
  /** Colour shared by every primitive so far (may be a negative sentinel). */
  uniform = 0;
  colors: number[] | null = null;

  note(color: number): void {
    if (this.count === 0) this.uniform = color;
    else if (this.colors) this.colors.push(color);
    else if (color !== this.uniform) {
      this.colors = new Array<number>(this.count).fill(this.uniform);
      this.colors.push(color);
    }
    this.count++;
  }
}

class LayerAcc {
  tri = new Bucket();
  seg = new Bucket();
  pt = new Bucket();
}

class Tile {
  layers = new Map<string, LayerAcc>();
  lastName = '';
  last: LayerAcc | null = null;
  ox: number; oy: number; oz = 0;
  hasZ = false;
  verts = 0;
  minX = Infinity; minY = Infinity; minZ = Infinity;
  maxX = -Infinity; maxY = -Infinity; maxZ = -Infinity;
  constructor(public ix: number, public iy: number) {
    this.ox = (ix + 0.5) * TILE;
    this.oy = (iy + 0.5) * TILE;
  }
  bound(x: number, y: number, z: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
    this.verts++;
  }
}

export interface BuiltModel {
  origin: Vec3;
  layers: ParsedLayer[];
  labels: ParsedLabels;
  bbox: { min: Vec3; max: Vec3 } | null;
  /** Bounding box of the main model without far outliers. */
  focus: { min: Vec3; max: Vec3 } | null;
  farOutliers: boolean;
  triangles: number;
  segments: number;
  points: number;
  texts: number;
  nonFinite: number;
}

type Kind = 'tri' | 'seg' | 'pt';

export class ModelBuilder implements GeometrySink {
  private tiles = new Map<string, Tile>();
  private tile: Tile | null = null;
  private lastIx = NaN;
  private lastIy = NaN;
  private layerOrder = new Map<string, number>();
  private lblPos: number[] = [];
  private lblH: number[] = [];
  private lblLayer: number[] = [];
  private lblText: string[] = [];
  private nonFinite = 0;
  private prims = 0;

  private layerIndex(name: string): number {
    let i = this.layerOrder.get(name);
    if (i === undefined) {
      i = this.layerOrder.size;
      this.layerOrder.set(name, i);
    }
    return i;
  }

  /** Tile for a primitive, chosen by its first vertex. */
  private tileAt(x: number, y: number, z: number): Tile {
    const ix = Math.floor(x * INV_TILE), iy = Math.floor(y * INV_TILE);
    if (ix === this.lastIx && iy === this.lastIy) return this.tile as Tile;
    const key = ix + ',' + iy;
    let t = this.tiles.get(key);
    if (!t) {
      t = new Tile(ix, iy);
      this.tiles.set(key, t);
    }
    if (!t.hasZ) { t.hasZ = true; t.oz = Math.round(z); }
    this.tile = t;
    this.lastIx = ix;
    this.lastIy = iy;
    return t;
  }

  private acc(t: Tile, name: string): LayerAcc {
    if (t.last !== null && name === t.lastName) return t.last;
    let a = t.layers.get(name);
    if (!a) {
      a = new LayerAcc();
      t.layers.set(name, a);
      this.layerIndex(name);
    }
    t.lastName = name;
    t.last = a;
    return a;
  }

  /** Rejects NaN, infinities and values so large they can only be garbage. */
  private ok(sumAbs: number): boolean {
    if (sumAbs < 1e12) return true;
    this.nonFinite++;
    return false;
  }

  tri(layer: string, color: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    if (!this.ok(Math.abs(ax) + Math.abs(ay) + Math.abs(az) + Math.abs(bx) + Math.abs(by) + Math.abs(bz) + Math.abs(cx) + Math.abs(cy) + Math.abs(cz))) return;
    const t = this.tileAt(ax, ay, az);
    t.bound(ax, ay, az); t.bound(bx, by, bz); t.bound(cx, cy, cz);
    const b = this.acc(t, layer).tri;
    const ox = t.ox, oy = t.oy, oz = t.oz;
    b.pos.push3(ax - ox, ay - oy, az - oz);
    b.pos.push3(bx - ox, by - oy, bz - oz);
    b.pos.push3(cx - ox, cy - oy, cz - oz);
    b.note(color);
    this.prims++;
  }

  seg(layer: string, color: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    if (!this.ok(Math.abs(ax) + Math.abs(ay) + Math.abs(az) + Math.abs(bx) + Math.abs(by) + Math.abs(bz))) return;
    const t = this.tileAt(ax, ay, az);
    t.bound(ax, ay, az); t.bound(bx, by, bz);
    const b = this.acc(t, layer).seg;
    b.pos.push3(ax - t.ox, ay - t.oy, az - t.oz);
    b.pos.push3(bx - t.ox, by - t.oy, bz - t.oz);
    b.note(color);
    this.prims++;
  }

  point(layer: string, color: number, x: number, y: number, z: number): void {
    if (!this.ok(Math.abs(x) + Math.abs(y) + Math.abs(z))) return;
    const t = this.tileAt(x, y, z);
    t.bound(x, y, z);
    const b = this.acc(t, layer).pt;
    b.pos.push3(x - t.ox, y - t.oy, z - t.oz);
    b.note(color);
    this.prims++;
  }

  text(layer: string, _color: number, x: number, y: number, z: number, height: number, text: string): void {
    if (!this.ok(Math.abs(x) + Math.abs(y) + Math.abs(z))) return;
    const t = this.tileAt(x, y, z);
    t.bound(x, y, z);
    this.lblPos.push(x, y, z);
    this.lblH.push(height > 0 && height < 1e9 ? height : 0);
    this.lblLayer.push(this.layerIndex(layer));
    this.lblText.push(text);
    this.prims++;
  }

  get primitiveCount(): number {
    return this.prims;
  }

  /** defs: layer table of the file (empty for non-DXF formats). */
  finish(defs: LayerDef[]): BuiltModel {
    const byName = new Map<string, LayerDef>();
    const byUpper = new Map<string, LayerDef>();
    for (const d of defs) { byName.set(d.name, d); byUpper.set(d.name.toUpperCase(), d); }

    // The tile with most vertices holds the model proper.
    let main: Tile | null = null;
    for (const t of this.tiles.values()) if (!main || t.verts > main.verts) main = t;
    const origin: Vec3 = main ? [main.ox, main.oy, main.oz] : [0, 0, 0];
    const ordered = main ? [main, ...[...this.tiles.values()].filter((t) => t !== main)] : [];

    let bbox: BuiltModel['bbox'] = null;
    let focus: BuiltModel['focus'] = null;
    let farOutliers = false;
    for (const t of ordered) {
      bbox = grow(bbox, t);
      if (main && Math.abs(t.ix - main.ix) <= FOCUS_CELLS && Math.abs(t.iy - main.iy) <= FOCUS_CELLS) focus = grow(focus, t);
      else farOutliers = true;
    }

    const layers: ParsedLayer[] = [];
    let triangles = 0, segments = 0, points = 0;
    let fallback = 0;
    for (const name of this.layerOrder.keys()) {
      const def = byName.get(name) ?? byUpper.get(name.toUpperCase());
      const defColor = def?.color ?? null;
      const tri = this.merge(ordered, name, 'tri', origin);
      const seg = this.merge(ordered, name, 'seg', origin);
      const pt = this.merge(ordered, name, 'pt', origin);
      triangles += tri?.count ?? 0; segments += seg?.count ?? 0; points += pt?.count ?? 0;
      let color = defColor;
      if (color === null) {
        // No layer table entry: a layer drawn in one explicit colour takes it.
        color = tri?.uniform ?? seg?.uniform ?? pt?.uniform ?? null;
        if (color === null) color = FALLBACK_PALETTE[fallback++ % FALLBACK_PALETTE.length];
      }
      const triSet = tri ? colorize(tri, color, 3) : null;
      layers.push({
        name,
        color,
        hidden: def?.hidden ?? false,
        tri: triSet ? { ...triSet, bvh: null } : null,
        seg: seg ? colorize(seg, color, 2) : null,
        pt: pt ? colorize(pt, color, 1) : null,
      });
    }

    const n = this.lblText.length;
    const lpos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 3) {
      lpos[i] = this.lblPos[i] - origin[0];
      lpos[i + 1] = this.lblPos[i + 1] - origin[1];
      lpos[i + 2] = this.lblPos[i + 2] - origin[2];
    }
    const labels: ParsedLabels = {
      pos: lpos,
      height: Float32Array.from(this.lblH),
      layer: Uint32Array.from(this.lblLayer),
      text: this.lblText,
    };
    this.tiles.clear();
    this.tile = null;
    this.lastIx = NaN;
    return {
      origin, layers, labels, bbox, focus, farOutliers,
      triangles, segments, points, texts: n, nonFinite: this.nonFinite,
    };
  }

  /** Joins one layer's buckets from all tiles into a single buffer at `origin`. */
  private merge(tiles: Tile[], name: string, kind: Kind, origin: Vec3): Merged | null {
    const parts: { b: Bucket; t: Tile }[] = [];
    let floats = 0, count = 0;
    for (const t of tiles) {
      const b = t.layers.get(name)?.[kind];
      if (b && b.count > 0) { parts.push({ b, t }); floats += b.pos.length; count += b.count; }
    }
    if (parts.length === 0) return null;
    const mixed = parts.some((p) => p.b.colors !== null || p.b.uniform !== parts[0].b.uniform);
    const pos = new Float32Array(floats);
    const colors = mixed ? new Int32Array(count) : null;
    let off = 0, prim = 0;
    for (const { b, t } of parts) {
      const len = b.pos.length;
      b.pos.drain(pos, off, t.ox - origin[0], t.oy - origin[1], t.oz - origin[2]);
      off += len;
      if (colors) {
        if (b.colors) for (let i = 0; i < b.count; i++) colors[prim + i] = b.colors[i];
        else colors.fill(b.uniform, prim, prim + b.count);
      }
      prim += b.count;
      b.colors = null;
    }
    const u = parts[0].b.uniform;
    return { pos, colors, count, uniform: mixed || u < 0 ? null : u };
  }
}

interface Merged {
  pos: Float32Array;
  /** Per-primitive colour (negative = BYLAYER) or null when uniform. */
  colors: Int32Array | null;
  count: number;
  /** The single explicit colour of every primitive, if there is one. */
  uniform: number | null;
}

function grow(box: { min: Vec3; max: Vec3 } | null, t: Tile): { min: Vec3; max: Vec3 } {
  if (!box) return { min: [t.minX, t.minY, t.minZ], max: [t.maxX, t.maxY, t.maxZ] };
  box.min[0] = Math.min(box.min[0], t.minX); box.min[1] = Math.min(box.min[1], t.minY); box.min[2] = Math.min(box.min[2], t.minZ);
  box.max[0] = Math.max(box.max[0], t.maxX); box.max[1] = Math.max(box.max[1], t.maxY); box.max[2] = Math.max(box.max[2], t.maxZ);
  return box;
}

/** Per-vertex colours are produced only where they differ from the layer colour. */
function colorize(m: Merged, layerColor: number, vertsPerPrim: number): PrimitiveSet {
  if (!m.colors && (m.uniform === null || m.uniform === layerColor)) return { pos: m.pos, col: null };
  const col = new Uint8Array(m.count * vertsPerPrim * 3);
  let o = 0;
  for (let i = 0; i < m.count; i++) {
    let c = m.colors ? m.colors[i] : (m.uniform as number);
    if (c < 0) c = layerColor;
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    for (let k = 0; k < vertsPerPrim; k++) { col[o++] = r; col[o++] = g; col[o++] = b; }
  }
  return { pos: m.pos, col };
}
