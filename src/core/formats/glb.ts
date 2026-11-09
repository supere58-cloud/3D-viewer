/**
 * Minimal GLB (binary glTF 2.0) geometry reader: node transforms, positions,
 * indices and base colours. Textures, skins and animation are ignored, which
 * also means nothing is ever fetched. glTF is Y-up; output is Z-up.
 */
import { LoadError, type GeometrySink } from '../types';

interface Accessor {
  bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number;
  type: string; sparse?: unknown;
}
interface BufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }
interface Primitive { attributes: Record<string, number>; indices?: number; mode?: number; material?: number; extensions?: Record<string, unknown> }
interface Gltf {
  scenes?: { nodes?: number[] }[]; scene?: number;
  nodes?: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { name?: string; primitives: Primitive[] }[];
  materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: unknown } }[];
  accessors?: Accessor[]; bufferViews?: BufferView[];
  extensionsRequired?: string[];
  images?: unknown[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function mul(a: number[], b: number[]): number[] {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function trs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): number[] {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export interface GlbInfo { meshes: number; primitives: number; texturesDropped: boolean; skipped: Record<string, number> }

export function parseGlb(data: Uint8Array, sink: GeometrySink, defaultLayer: string): GlbInfo {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new LoadError('glbInvalid');
  if (dv.getUint32(4, true) !== 2) throw new LoadError('glbInvalid', 'version');
  let json: Gltf | null = null;
  let bin: Uint8Array | null = null;
  let off = 12;
  while (off + 8 <= data.length) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const body = data.subarray(off + 8, Math.min(off + 8 + len, data.length));
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as Gltf;
    else if (type === 0x004e4942 && !bin) bin = body;
    off += 8 + len;
  }
  if (!json) throw new LoadError('glbInvalid', 'json');
  const g = json;
  const required = g.extensionsRequired ?? [];
  if (required.some((e) => /draco|meshopt/i.test(e))) throw new LoadError('glbCompressed', required.join(', '));

  const info: GlbInfo = { meshes: 0, primitives: 0, texturesDropped: (g.images?.length ?? 0) > 0, skipped: Object.create(null) };
  const skip = (k: string) => { info.skipped[k] = (info.skipped[k] ?? 0) + 1; };

  const read = (index: number): { get: (i: number, c: number) => number; count: number; size: number } | null => {
    const acc = g.accessors?.[index];
    if (!acc || acc.bufferView === undefined || !bin) return null;
    const bv = g.bufferViews?.[acc.bufferView];
    if (!bv || bv.buffer !== 0) return null;
    const size = COMPONENTS[acc.type] ?? 0;
    if (!size) return null;
    const ct = acc.componentType;
    const bytes = ct === 5126 || ct === 5125 ? 4 : ct === 5123 || ct === 5122 ? 2 : 1;
    const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : bytes * size;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    if (base + stride * (acc.count - 1) + bytes * size > bin.byteLength) return null;
    const norm = acc.normalized === true;
    const get = (i: number, c: number): number => {
      const p = base + i * stride + c * bytes;
      switch (ct) {
        case 5126: return view.getFloat32(p, true);
        case 5125: return view.getUint32(p, true);
        case 5123: { const v = view.getUint16(p, true); return norm ? v / 65535 : v; }
        case 5122: { const v = view.getInt16(p, true); return norm ? Math.max(v / 32767, -1) : v; }
        case 5121: { const v = view.getUint8(p); return norm ? v / 255 : v; }
        case 5120: { const v = view.getInt8(p); return norm ? Math.max(v / 127, -1) : v; }
        default: return NaN;
      }
    };
    return { get, count: acc.count, size };
  };

  const visit = (nodeIndex: number, parent: number[], depth: number): void => {
    const node = g.nodes?.[nodeIndex];
    if (!node || depth > 64) return;
    const local = node.matrix && node.matrix.length === 16 ? node.matrix : trs(node.translation, node.rotation, node.scale);
    const m = mul(parent, local);
    const mesh = node.mesh !== undefined ? g.meshes?.[node.mesh] : undefined;
    if (mesh) {
      info.meshes++;
      const layer = node.name || mesh.name || defaultLayer;
      for (const prim of mesh.primitives ?? []) {
        if (prim.extensions && Object.keys(prim.extensions).some((e) => /draco/i.test(e))) throw new LoadError('glbCompressed', 'draco');
        const pos = prim.attributes?.POSITION !== undefined ? read(prim.attributes.POSITION) : null;
        if (!pos || pos.size !== 3) { skip('primitive without POSITION'); continue; }
        info.primitives++;
        const idx = prim.indices !== undefined ? read(prim.indices) : null;
        const n = idx ? idx.count : pos.count;
        const at = (i: number): number => (idx ? idx.get(i, 0) : i);
        const f = g.materials?.[prim.material ?? -1]?.pbrMetallicRoughness?.baseColorFactor;
        const color = f
          ? (Math.round(Math.min(1, Math.max(0, f[0])) * 255) << 16) | (Math.round(Math.min(1, Math.max(0, f[1])) * 255) << 8) | Math.round(Math.min(1, Math.max(0, f[2])) * 255)
          : -1;
        const p = new Float64Array(9);
        const load = (vi: number, dst: number): boolean => {
          if (!(vi >= 0 && vi < pos.count)) return false;
          const x = pos.get(vi, 0), y = pos.get(vi, 1), z = pos.get(vi, 2);
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          // Y-up to Z-up
          p[dst] = wx; p[dst + 1] = -wz; p[dst + 2] = wy;
          return true;
        };
        const tri = (a: number, b: number, c: number): void => {
          if (load(at(a), 0) && load(at(b), 3) && load(at(c), 6)) sink.tri(layer, color, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
        };
        const seg = (a: number, b: number): void => {
          if (load(at(a), 0) && load(at(b), 3)) sink.seg(layer, color, p[0], p[1], p[2], p[3], p[4], p[5]);
        };
        switch (prim.mode ?? 4) {
          case 4: for (let i = 0; i + 2 < n; i += 3) tri(i, i + 1, i + 2); break;
          case 5: for (let i = 0; i + 2 < n; i++) { if (i % 2 === 0) tri(i, i + 1, i + 2); else tri(i + 1, i, i + 2); } break;
          case 6: for (let i = 1; i + 1 < n; i++) tri(0, i, i + 1); break;
          case 1: for (let i = 0; i + 1 < n; i += 2) seg(i, i + 1); break;
          case 3: for (let i = 0; i + 1 < n; i++) seg(i, i + 1); break;
          case 2: for (let i = 0; i < n; i++) seg(i, (i + 1) % n); break;
          case 0: for (let i = 0; i < n; i++) { if (load(at(i), 0)) sink.point(layer, color, p[0], p[1], p[2]); } break;
          default: skip('primitive mode ' + prim.mode);
        }
      }
    }
    for (const c of node.children ?? []) visit(c, m, depth + 1);
  };

  const identity = trs();
  const scene = g.scenes?.[g.scene ?? 0];
  const roots = scene?.nodes ?? (g.nodes ? g.nodes.map((_n, i) => i).filter((i) => !g.nodes!.some((n) => n.children?.includes(i))) : []);
  for (const r of roots) visit(r, identity, 0);
  return info;
}
