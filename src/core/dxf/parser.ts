/**
 * Streaming ASCII DXF parser (R12 .. 2018).
 *
 * Bytes go in through push(); primitives come out through a GeometrySink in
 * true float64 coordinates. The parser is deliberately tolerant: unknown
 * entities are skipped and counted, malformed lines are counted and the
 * tokenizer resynchronises, a truncated file yields everything read so far.
 */
import { BYBLOCK, BYLAYER, type GeometrySink, type LayerDef, type WarningCode } from '../types';
import { LineSplitter, asciiString, parseFloatBytes, parseIntBytes } from '../lines';
import { aciToRgb } from './aci';
import { DxfStringDecoder, decodeMText, decodePlainText } from './encoding';

const enum Section { None, Header, Tables, Blocks, Entities, Other }
const enum Rec { None, Section, Table, Layer, Block, Entity, Ignore }

const MAX_INSERT_DEPTH = 16;
const NO_INT = -2147483648;

const HANDLED = new Set([
  '3DFACE', 'SOLID', 'TRACE', 'LINE', 'POINT', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'SEQEND', 'TEXT', 'MTEXT',
  'ATTRIB', 'INSERT', 'CIRCLE', 'ARC',
]);

interface Run { kind: 0 | 1 | 2; layer: string; color: number; data: number[] }
interface BlockText { layer: string; color: number; x: number; y: number; z: number; h: number; text: string }
interface BlockInsert { name: string; layer: string; color: number; m: Float64Array }

/** A block definition records its primitives in block-local coordinates. */
class Block implements GeometrySink {
  runs: Run[] = [];
  texts: BlockText[] = [];
  inserts: BlockInsert[] = [];
  bx = 0; by = 0; bz = 0;
  constructor(public name: string) {}

  private run(kind: 0 | 1 | 2, layer: string, color: number): number[] {
    const last = this.runs[this.runs.length - 1];
    if (last && last.kind === kind && last.color === color && last.layer === layer) return last.data;
    const r: Run = { kind, layer, color, data: [] };
    this.runs.push(r);
    return r.data;
  }
  tri(l: string, c: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    this.run(0, l, c).push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }
  seg(l: string, c: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    this.run(1, l, c).push(ax, ay, az, bx, by, bz);
  }
  point(l: string, c: number, x: number, y: number, z: number): void {
    this.run(2, l, c).push(x, y, z);
  }
  text(l: string, c: number, x: number, y: number, z: number, h: number, text: string): void {
    this.texts.push({ layer: l, color: c, x, y, z, h, text });
  }
}

export interface DxfInfo {
  layers: LayerDef[];
  encoding: string;
  codepage: string | null;
  version: string | null;
  entities: Record<string, number>;
  skipped: Record<string, number>;
  malformedLines: number;
  blocks: number;
  warnings: WarningCode[];
}

export class DxfParser {
  private splitter: LineSplitter;
  private decoder = new DxfStringDecoder();
  private expectCode = true;
  private code = 0;
  private sawAnyPair = false;

  private section: Section = Section.None;
  private rec: Rec = Rec.None;
  private sawEof = false;
  private headerVar = '';
  private tableName = '';

  private codepage: string | null = null;
  private version: string | null = null;
  private layers = new Map<string, LayerDef>();
  private blocks = new Map<string, Block>();
  private curBlock: Block | null = null;
  private out: GeometrySink;

  private entities: Record<string, number> = Object.create(null);
  private skipped: Record<string, number> = Object.create(null);
  private malformed = 0;
  private warnings = new Set<WarningCode>();

  // --- current record -------------------------------------------------
  private type = '';
  private handled = false;
  private bad = false;
  private layer = '0';
  private c62 = NO_INT;
  private c420 = -1;
  private paper = false;
  private has = 0;
  private x = new Float64Array(4);
  private y = new Float64Array(4);
  private z = new Float64Array(4);
  private elev = 0;
  private f40 = 0; private f41 = 1; private f42 = 1; private f43 = 1; private f44 = 0; private f45 = 0;
  private f50 = 0; private f51 = 360;
  private i70 = 0; private i71 = 0; private i72 = 0; private i73 = 0; private i74 = 0;
  private nx = 0; private ny = 0; private nz = 1;
  private text1 = '';
  private text3 = '';
  private name = '';
  private lw: number[] = [];
  private lwBulge = false;
  // layer-table record
  private lyName = ''; private lyColor = NO_INT; private lyTrue = -1; private lyFlags = 0;

  // --- polyline in progress -------------------------------------------
  private plActive = false;
  private plFlags = 0;
  private plLayer = '0';
  private plColor = BYLAYER;
  private plM = 0; private plN = 0;
  private plElev = 0;
  private plOcs: Float64Array | null = null;
  private plVerts: number[] = [];
  private plFaces: number[] = [];

  constructor(private sink: GeometrySink) {
    this.out = sink;
    this.splitter = new LineSplitter((buf, s, e) => this.line(buf, s, e));
  }

  push(chunk: Uint8Array): void {
    this.splitter.push(chunk);
  }

  finish(): DxfInfo {
    this.splitter.finish();
    if (!this.sawEof) {
      // The record being read may be incomplete: drop it, keep what is whole.
      const clean = this.section === Section.None && this.rec !== Rec.Section;
      this.warnings.add(clean && this.sawAnyPair ? 'noEof' : 'truncated');
      if (this.rec === Rec.Entity && !this.handled) {
        // The last type name may itself be cut short; do not report it.
        for (const bag of [this.entities, this.skipped]) {
          if (--bag[this.type] <= 0) delete bag[this.type];
        }
      }
      this.rec = Rec.None;
      if (this.plActive) this.flushPolyline();
    }
    if (this.malformed > 0) this.warnings.add('malformedLines');
    return {
      layers: [...this.layers.values()],
      encoding: this.decoder.detected,
      codepage: this.codepage,
      version: this.version,
      entities: this.entities,
      skipped: this.skipped,
      malformedLines: this.malformed,
      blocks: this.blocks.size,
      warnings: [...this.warnings],
    };
  }

  // ---------------------------------------------------------------------
  private line(buf: Uint8Array, s: number, e: number): void {
    if (this.expectCode) {
      const code = parseIntBytes(buf, s, e);
      if (code !== code) {
        // Blank lines between pairs are harmless; anything else is counted.
        for (let i = s; i < e; i++) {
          if (buf[i] !== 32 && buf[i] !== 9) { this.malformed++; break; }
        }
        return;
      }
      this.code = code;
      this.expectCode = false;
      return;
    }
    this.expectCode = true;
    this.sawAnyPair = true;
    this.pair(this.code, buf, s, e);
  }

  private pair(code: number, buf: Uint8Array, s: number, e: number): void {
    if (code === 0) {
      this.endRecord();
      this.beginRecord(asciiString(buf, s, e).toUpperCase());
      return;
    }
    switch (this.rec) {
      case Rec.Entity:
        if (this.handled) this.entityPair(code, buf, s, e);
        return;
      case Rec.Section:
        if (code === 2) {
          const name = asciiString(buf, s, e).toUpperCase();
          this.section =
            name === 'HEADER' ? Section.Header
            : name === 'TABLES' ? Section.Tables
            : name === 'BLOCKS' ? Section.Blocks
            : name === 'ENTITIES' ? Section.Entities
            : Section.Other;
          this.rec = Rec.None;
        }
        return;
      case Rec.Table:
        if (code === 2) this.tableName = asciiString(buf, s, e).toUpperCase();
        return;
      case Rec.Layer:
        if (code === 2) this.lyName = this.decoder.decode(buf, s, e);
        else if (code === 62) this.lyColor = this.int(buf, s, e);
        else if (code === 420) this.lyTrue = this.int(buf, s, e);
        else if (code === 70) this.lyFlags = this.int(buf, s, e);
        return;
      case Rec.Block:
        if (code === 2) this.name = this.decoder.decode(buf, s, e);
        else if (code === 10) this.x[0] = this.num(buf, s, e);
        else if (code === 20) this.y[0] = this.num(buf, s, e);
        else if (code === 30) this.z[0] = this.num(buf, s, e);
        return;
      case Rec.None:
        if (this.section === Section.Header) this.headerPair(code, buf, s, e);
        return;
      default:
        return;
    }
  }

  private headerPair(code: number, buf: Uint8Array, s: number, e: number): void {
    if (code === 9) {
      this.headerVar = asciiString(buf, s, e).toUpperCase();
    } else if (this.headerVar === '$DWGCODEPAGE' && code === 3) {
      this.codepage = asciiString(buf, s, e);
      this.decoder.setCodepage(this.codepage);
    } else if (this.headerVar === '$ACADVER' && code === 1) {
      this.version = asciiString(buf, s, e);
    }
  }

  private int(buf: Uint8Array, s: number, e: number): number {
    const v = parseIntBytes(buf, s, e);
    if (v !== v) {
      const f = parseFloatBytes(buf, s, e);
      if (f !== f) { this.malformed++; return 0; }
      return Math.round(f);
    }
    return v;
  }

  private num(buf: Uint8Array, s: number, e: number): number {
    const v = parseFloatBytes(buf, s, e);
    if (v !== v || v === Infinity || v === -Infinity) {
      this.bad = true;
      this.malformed++;
      return 0;
    }
    return v;
  }

  private beginRecord(type: string): void {
    this.rec = Rec.None;
    if (this.plActive && type !== 'VERTEX') this.flushPolyline();
    switch (type) {
      case 'SECTION': this.rec = Rec.Section; return;
      case 'ENDSEC': this.section = Section.None; this.curBlock = null; this.out = this.sink; return;
      case 'EOF': this.sawEof = true; this.section = Section.None; return;
    }
    switch (this.section) {
      case Section.Header:
      case Section.Other:
        this.rec = Rec.Ignore;
        return;
      case Section.Tables:
        if (type === 'TABLE') { this.rec = Rec.Table; this.tableName = ''; }
        else if (type === 'ENDTAB') this.tableName = '';
        else if (type === 'LAYER' && (this.tableName === 'LAYER' || this.tableName === '')) {
          this.rec = Rec.Layer;
          this.lyName = ''; this.lyColor = NO_INT; this.lyTrue = -1; this.lyFlags = 0;
        } else this.rec = Rec.Ignore;
        return;
      case Section.Blocks:
        if (type === 'BLOCK') {
          this.rec = Rec.Block;
          this.name = '';
          this.x[0] = this.y[0] = this.z[0] = 0;
          this.bad = false;
          return;
        }
        if (type === 'ENDBLK') {
          this.curBlock = null;
          this.out = this.sink;
          this.rec = Rec.Ignore;
          return;
        }
        if (!this.curBlock) { this.rec = Rec.Ignore; return; }
        break;
      default:
        break;
    }
    // An entity (ENTITIES section, inside a BLOCK, or a file without sections).
    this.rec = Rec.Entity;
    this.type = type;
    this.entities[type] = (this.entities[type] ?? 0) + 1;
    this.handled = HANDLED.has(type);
    if (!this.handled) {
      this.skipped[type] = (this.skipped[type] ?? 0) + 1;
      return;
    }
    this.bad = false;
    this.layer = '0';
    this.c62 = NO_INT;
    this.c420 = -1;
    this.paper = false;
    this.has = 0;
    this.elev = 0;
    this.f40 = 0; this.f41 = 1; this.f42 = 1; this.f43 = 1; this.f44 = 0; this.f45 = 0;
    this.f50 = 0; this.f51 = 360;
    this.i70 = 0; this.i71 = 0; this.i72 = 0; this.i73 = 0; this.i74 = 0;
    this.nx = 0; this.ny = 0; this.nz = 1;
    this.text1 = ''; this.text3 = ''; this.name = '';
    this.z[0] = this.z[1] = this.z[2] = this.z[3] = 0;
    if (type === 'LWPOLYLINE') { this.lw.length = 0; this.lwBulge = false; }
  }

  private entityPair(code: number, buf: Uint8Array, s: number, e: number): void {
    if (code >= 10 && code <= 33) {
      const idx = code % 10;
      if (idx > 3) return;
      const v = this.num(buf, s, e);
      if (code < 20) {
        if (idx === 0 && this.type === 'LWPOLYLINE') { this.lw.push(v, 0); return; }
        this.x[idx] = v;
        this.has |= 1 << idx;
      } else if (code < 30) {
        if (idx === 0 && this.type === 'LWPOLYLINE') {
          if (this.lw.length > 0) this.lw[this.lw.length - 1] = v;
          return;
        }
        this.y[idx] = v;
      } else {
        this.z[idx] = v;
      }
      return;
    }
    switch (code) {
      case 8: this.layer = this.decoder.decode(buf, s, e) || '0'; break;
      case 62: this.c62 = this.int(buf, s, e); break;
      case 420: this.c420 = this.int(buf, s, e); break;
      case 1: this.text1 = this.decoder.decode(buf, s, e); break;
      case 3: this.text3 += this.decoder.decode(buf, s, e); break;
      case 2: this.name = this.decoder.decode(buf, s, e); break;
      case 38: this.elev = this.num(buf, s, e); break;
      case 40: this.f40 = this.num(buf, s, e); break;
      case 41: this.f41 = this.num(buf, s, e); break;
      case 42:
        if (this.type === 'LWPOLYLINE' || this.type === 'VERTEX') {
          if (this.num(buf, s, e) !== 0) this.lwBulge = true;
        } else this.f42 = this.num(buf, s, e);
        break;
      case 43: this.f43 = this.num(buf, s, e); break;
      case 44: this.f44 = this.num(buf, s, e); break;
      case 45: this.f45 = this.num(buf, s, e); break;
      case 50: this.f50 = this.num(buf, s, e); break;
      case 51: this.f51 = this.num(buf, s, e); break;
      case 67: this.paper = this.int(buf, s, e) === 1; break;
      case 70: this.i70 = this.int(buf, s, e); break;
      case 71: this.i71 = this.int(buf, s, e); break;
      case 72: this.i72 = this.int(buf, s, e); break;
      case 73: this.i73 = this.int(buf, s, e); break;
      case 74: this.i74 = this.int(buf, s, e); break;
      case 210: this.nx = this.num(buf, s, e); break;
      case 220: this.ny = this.num(buf, s, e); break;
      case 230: this.nz = this.num(buf, s, e); break;
      default: break;
    }
  }

  private color(): number {
    if (this.c420 >= 0) return this.c420 & 0xffffff;
    const c = this.c62;
    if (c === NO_INT || c === 256) return BYLAYER;
    if (c === 0) return BYBLOCK;
    return aciToRgb(c);
  }

  /** Arbitrary Axis Algorithm: returns [Ax, Ay, N] or null for the world Z. */
  private ocs(): Float64Array | null {
    let nx = this.nx, ny = this.ny, nz = this.nz;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) return null;
    nx /= len; ny /= len; nz /= len;
    if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz > 0) return null;
    let ax: number, ay: number, az: number;
    if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
      // Wy x N
      ax = nz; ay = 0; az = -nx;
    } else {
      // Wz x N
      ax = -ny; ay = nx; az = 0;
    }
    const al = Math.hypot(ax, ay, az);
    ax /= al; ay /= al; az /= al;
    const bx = ny * az - nz * ay;
    const by = nz * ax - nx * az;
    const bz = nx * ay - ny * ax;
    return Float64Array.of(ax, ay, az, bx, by, bz, nx, ny, nz);
  }

  private endRecord(): void {
    const rec = this.rec;
    this.rec = Rec.None;
    if (rec === Rec.Layer) {
      if (this.lyName) {
        let color: number | null = null;
        if (this.lyTrue >= 0) color = this.lyTrue & 0xffffff;
        else if (this.lyColor !== NO_INT) color = aciToRgb(this.lyColor);
        const hidden = (this.lyColor !== NO_INT && this.lyColor < 0) || (this.lyFlags & 1) === 1;
        this.layers.set(this.lyName, { name: this.lyName, color, hidden });
      }
      return;
    }
    if (rec === Rec.Block) {
      const b = new Block(this.name);
      b.bx = this.x[0]; b.by = this.y[0]; b.bz = this.z[0];
      this.blocks.set(this.name.toUpperCase(), b);
      this.curBlock = b;
      this.out = b;
      return;
    }
    if (rec !== Rec.Entity || !this.handled) return;
    if (this.bad) {
      this.skip('(malformed)');
      return;
    }
    if (this.paper) {
      this.warnings.add('paperSpaceSkipped');
      this.skip('(paper space)');
      return;
    }
    this.emitEntity();
  }

  private skip(key: string): void {
    this.skipped[key] = (this.skipped[key] ?? 0) + 1;
  }

  private emitEntity(): void {
    const out = this.out;
    const x = this.x, y = this.y, z = this.z;
    const layer = this.layer;
    switch (this.type) {
      case '3DFACE': {
        if ((this.has & 7) !== 7) { this.skip('(incomplete)'); return; }
        const color = this.color();
        this.triangle(out, layer, color, x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]);
        if ((this.has & 8) !== 0 && !(x[3] === x[2] && y[3] === y[2] && z[3] === z[2])) {
          this.triangle(out, layer, color, x[0], y[0], z[0], x[2], y[2], z[2], x[3], y[3], z[3]);
        }
        return;
      }
      case 'SOLID':
      case 'TRACE': {
        if ((this.has & 7) !== 7) { this.skip('(incomplete)'); return; }
        const color = this.color();
        const o = this.ocs();
        // SOLID stores corners in a Z pattern (1,2,4,3) and in OCS at one elevation.
        const p = new Float64Array(12);
        const n = (this.has & 8) !== 0 ? 4 : 3;
        for (let i = 0; i < n; i++) this.toWcs(o, x[i], y[i], z[0], p, i * 3);
        this.triangle(out, layer, color, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
        if (n === 4) this.triangle(out, layer, color, p[3], p[4], p[5], p[9], p[10], p[11], p[6], p[7], p[8]);
        return;
      }
      case 'LINE':
        if ((this.has & 3) !== 3) { this.skip('(incomplete)'); return; }
        out.seg(layer, this.color(), x[0], y[0], z[0], x[1], y[1], z[1]);
        return;
      case 'POINT':
        if ((this.has & 1) !== 1) { this.skip('(incomplete)'); return; }
        out.point(layer, this.color(), x[0], y[0], z[0]);
        return;
      case 'LWPOLYLINE': {
        const lw = this.lw;
        const n = lw.length >> 1;
        if (n < 2) { if (n === 0) this.skip('(incomplete)'); return; }
        if (this.lwBulge && !this.curBlock) this.warnings.add('bulgesIgnored');
        const color = this.color();
        const o = this.ocs();
        const a = new Float64Array(3), b = new Float64Array(3), first = new Float64Array(3);
        this.toWcs(o, lw[0], lw[1], this.elev, a, 0);
        first.set(a);
        for (let i = 1; i < n; i++) {
          this.toWcs(o, lw[i * 2], lw[i * 2 + 1], this.elev, b, 0);
          out.seg(layer, color, a[0], a[1], a[2], b[0], b[1], b[2]);
          a.set(b);
        }
        if ((this.i70 & 1) === 1 && n > 2) out.seg(layer, color, a[0], a[1], a[2], first[0], first[1], first[2]);
        return;
      }
      case 'POLYLINE': {
        this.plActive = true;
        this.plFlags = this.i70;
        this.plLayer = layer;
        this.plColor = this.color();
        this.plElev = z[0];
        this.plOcs = (this.i70 & (8 | 16 | 64)) === 0 ? this.ocs() : null;
        // Spline-fit meshes give the real counts in 73/74.
        const fit = (this.i70 & 4) !== 0 && this.i73 > 0 && this.i74 > 0;
        this.plM = fit ? this.i73 : this.i71;
        this.plN = fit ? this.i74 : this.i72;
        this.plVerts.length = 0;
        this.plFaces.length = 0;
        this.lwBulge = false;
        return;
      }
      case 'VERTEX': {
        if (!this.plActive) { this.skip('(orphan VERTEX)'); return; }
        const f = this.i70;
        if ((f & 128) !== 0 && (f & 64) === 0) {
          // Polyface face record: up to four 1-based vertex indices.
          const c = this.color();
          this.plFaces.push(Math.abs(this.i71), Math.abs(this.i72), Math.abs(this.i73), Math.abs(this.i74), c < 0 ? this.plColor : c);
          return;
        }
        if ((f & 16) !== 0) return; // spline frame control point
        if ((this.has & 1) !== 1) return;
        this.plVerts.push(x[0], y[0], z[0]);
        return;
      }
      case 'SEQEND':
        return;
      case 'TEXT':
      case 'ATTRIB': {
        const str = decodePlainText(this.text1);
        if (!str) return;
        const useAlign = (this.i72 !== 0 || this.i73 !== 0 || this.i74 !== 0) && (this.has & 2) !== 0;
        const p = new Float64Array(3);
        const k = useAlign ? 1 : 0;
        this.toWcs(this.ocs(), x[k], y[k], z[k], p, 0);
        out.text(layer, this.color(), p[0], p[1], p[2], this.f40, str);
        return;
      }
      case 'MTEXT': {
        const str = decodeMText(this.text3 + this.text1);
        if (!str) return;
        out.text(layer, this.color(), x[0], y[0], z[0], this.f40, str);
        return;
      }
      case 'CIRCLE':
      case 'ARC': {
        if ((this.has & 1) !== 1 || !(this.f40 > 0)) { this.skip('(incomplete)'); return; }
        const color = this.color();
        const o = this.ocs();
        let a0 = 0, sweep = Math.PI * 2;
        if (this.type === 'ARC') {
          a0 = (this.f50 * Math.PI) / 180;
          let a1 = (this.f51 * Math.PI) / 180;
          while (a1 <= a0) a1 += Math.PI * 2;
          sweep = Math.min(a1 - a0, Math.PI * 2);
        }
        const steps = Math.max(4, Math.ceil((sweep / (Math.PI * 2)) * 72));
        const a = new Float64Array(3), b = new Float64Array(3);
        this.toWcs(o, x[0] + this.f40 * Math.cos(a0), y[0] + this.f40 * Math.sin(a0), z[0], a, 0);
        for (let i = 1; i <= steps; i++) {
          const t = a0 + (sweep * i) / steps;
          this.toWcs(o, x[0] + this.f40 * Math.cos(t), y[0] + this.f40 * Math.sin(t), z[0], b, 0);
          out.seg(layer, color, a[0], a[1], a[2], b[0], b[1], b[2]);
          a.set(b);
        }
        return;
      }
      case 'INSERT':
        this.insert();
        return;
    }
  }

  private triangle(
    out: GeometrySink, layer: string, color: number,
    ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
  ): void {
    // Zero-area faces (two identical corners) carry no surface.
    if ((ax === bx && ay === by && az === bz) || (bx === cx && by === cy && bz === cz) || (ax === cx && ay === cy && az === cz)) return;
    out.tri(layer, color, ax, ay, az, bx, by, bz, cx, cy, cz);
  }

  private toWcs(o: Float64Array | null, px: number, py: number, pz: number, dst: Float64Array, at: number): void {
    if (!o) { dst[at] = px; dst[at + 1] = py; dst[at + 2] = pz; return; }
    dst[at] = px * o[0] + py * o[3] + pz * o[6];
    dst[at + 1] = px * o[1] + py * o[4] + pz * o[7];
    dst[at + 2] = px * o[2] + py * o[5] + pz * o[8];
  }

  // --- POLYLINE --------------------------------------------------------
  private flushPolyline(): void {
    this.plActive = false;
    const v = this.plVerts;
    const nv = (v.length / 3) | 0;
    const out = this.out;
    const layer = this.plLayer;
    const color = this.plColor;
    const flags = this.plFlags;
    if (nv === 0) return;

    if ((flags & 64) !== 0) {
      // Polyface mesh.
      const f = this.plFaces;
      let badFaces = 0;
      for (let i = 0; i < f.length; i += 5) {
        const idx: number[] = [];
        for (let k = 0; k < 4; k++) {
          const j = f[i + k];
          if (j === 0) continue;
          if (j > nv) { idx.length = 0; badFaces++; break; }
          idx.push((j - 1) * 3);
        }
        const c = f[i + 4];
        if (idx.length >= 3) {
          const a = idx[0], b = idx[1], d = idx[2];
          this.triangle(out, layer, c, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[d], v[d + 1], v[d + 2]);
          if (idx.length === 4 && idx[3] !== idx[2] && idx[3] !== idx[0]) {
            const e = idx[3];
            this.triangle(out, layer, c, v[a], v[a + 1], v[a + 2], v[d], v[d + 1], v[d + 2], v[e], v[e + 1], v[e + 2]);
          }
        } else if (idx.length === 2) {
          const a = idx[0], b = idx[1];
          out.seg(layer, c, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2]);
        }
      }
      if (badFaces > 0) this.warnings.add('badFaces');
      return;
    }

    if ((flags & 16) !== 0) {
      // Polygon mesh, M x N vertices, row-major in M.
      const N = this.plN;
      let M = this.plM;
      if (N < 2 || M < 2) { this.polylineSegments(); return; }
      if (M * N > nv) { M = Math.floor(nv / N); this.warnings.add('badFaces'); }
      const closedM = (flags & 1) !== 0, closedN = (flags & 32) !== 0;
      const mEnd = closedM ? M : M - 1;
      const nEnd = closedN ? N : N - 1;
      for (let i = 0; i < mEnd; i++) {
        const i2 = (i + 1) % M;
        for (let j = 0; j < nEnd; j++) {
          const j2 = (j + 1) % N;
          const a = (i * N + j) * 3, b = (i2 * N + j) * 3, c = (i2 * N + j2) * 3, d = (i * N + j2) * 3;
          this.triangle(out, layer, color, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]);
          this.triangle(out, layer, color, v[a], v[a + 1], v[a + 2], v[c], v[c + 1], v[c + 2], v[d], v[d + 1], v[d + 2]);
        }
      }
      return;
    }
    this.polylineSegments();
  }

  private polylineSegments(): void {
    const v = this.plVerts;
    const nv = (v.length / 3) | 0;
    const out = this.out;
    const layer = this.plLayer, color = this.plColor;
    const is3d = (this.plFlags & 8) !== 0;
    if (!is3d) {
      // 2D polyline: vertices are in OCS at the polyline's elevation.
      const o = this.plOcs;
      const p = new Float64Array(3);
      for (let i = 0; i < nv; i++) {
        this.toWcs(o, v[i * 3], v[i * 3 + 1], v[i * 3 + 2] !== 0 ? v[i * 3 + 2] : this.plElev, p, 0);
        v[i * 3] = p[0]; v[i * 3 + 1] = p[1]; v[i * 3 + 2] = p[2];
      }
      if (this.lwBulge && !this.curBlock) this.warnings.add('bulgesIgnored');
    }
    if (nv === 1) { out.point(layer, color, v[0], v[1], v[2]); return; }
    for (let i = 1; i < nv; i++) {
      const a = (i - 1) * 3, b = i * 3;
      out.seg(layer, color, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2]);
    }
    if ((this.plFlags & 1) !== 0 && nv > 2) {
      const a = (nv - 1) * 3;
      out.seg(layer, color, v[a], v[a + 1], v[a + 2], v[0], v[1], v[2]);
    }
  }

  // --- INSERT ----------------------------------------------------------
  private insert(): void {
    if (!this.name) { this.skip('(incomplete)'); return; }
    const o = this.ocs();
    const rot = (this.f50 * Math.PI) / 180;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const sx = this.f41, sy = this.f42, sz = this.f43;
    const cols = Math.max(1, this.i70), rows = Math.max(1, this.i71);
    const color = this.color();
    const layer = this.layer;
    const key = this.name.toUpperCase();
    const t = new Float64Array(3);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const offx = c * this.f44, offy = r * this.f45;
        // Linear part before OCS: Rz * S.
        const l = [cs * sx, -sn * sy, 0, sn * sx, cs * sy, 0, 0, 0, sz];
        const tx = this.x[0] + cs * offx - sn * offy;
        const ty = this.y[0] + sn * offx + cs * offy;
        const tz = this.z[0];
        const m = new Float64Array(12);
        if (o) {
          for (let col = 0; col < 3; col++) {
            this.toWcs(o, l[col], l[3 + col], l[6 + col], t, 0);
            m[col] = t[0]; m[4 + col] = t[1]; m[8 + col] = t[2];
          }
          this.toWcs(o, tx, ty, tz, t, 0);
        } else {
          for (let col = 0; col < 3; col++) { m[col] = l[col]; m[4 + col] = l[3 + col]; m[8 + col] = l[6 + col]; }
          t[0] = tx; t[1] = ty; t[2] = tz;
        }
        m[3] = t[0]; m[7] = t[1]; m[11] = t[2];
        if (this.curBlock) this.curBlock.inserts.push({ name: key, layer, color, m });
        else this.expand(key, m, layer, color, 0);
      }
    }
  }

  /** m is a row-major 3x4 matrix mapping (block point - base point) to the parent space. */
  private expand(key: string, m: Float64Array, insLayer: string, insColor: number, depth: number): void {
    const block = this.blocks.get(key);
    if (!block) { this.warnings.add('missingBlocks'); return; }
    if (depth > MAX_INSERT_DEPTH) { this.warnings.add('recursionLimit'); return; }
    const sink = this.sink;
    const bx = block.bx, by = block.by, bz = block.bz;
    const p = new Float64Array(9);
    const tf = (src: number[], at: number, dst: number): void => {
      const px = src[at] - bx, py = src[at + 1] - by, pz = src[at + 2] - bz;
      p[dst] = m[0] * px + m[1] * py + m[2] * pz + m[3];
      p[dst + 1] = m[4] * px + m[5] * py + m[6] * pz + m[7];
      p[dst + 2] = m[8] * px + m[9] * py + m[10] * pz + m[11];
    };
    for (const run of block.runs) {
      const layer = run.layer === '0' ? insLayer : run.layer;
      const color = run.color === BYBLOCK ? insColor : run.color;
      const d = run.data;
      if (run.kind === 0) {
        for (let i = 0; i < d.length; i += 9) {
          tf(d, i, 0); tf(d, i + 3, 3); tf(d, i + 6, 6);
          sink.tri(layer, color, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
        }
      } else if (run.kind === 1) {
        for (let i = 0; i < d.length; i += 6) {
          tf(d, i, 0); tf(d, i + 3, 3);
          sink.seg(layer, color, p[0], p[1], p[2], p[3], p[4], p[5]);
        }
      } else {
        for (let i = 0; i < d.length; i += 3) {
          tf(d, i, 0);
          sink.point(layer, color, p[0], p[1], p[2]);
        }
      }
    }
    if (block.texts.length > 0) {
      const scale = Math.hypot(m[1], m[5], m[9]);
      const src = [0, 0, 0];
      for (const t of block.texts) {
        src[0] = t.x; src[1] = t.y; src[2] = t.z;
        tf(src, 0, 0);
        sink.text(t.layer === '0' ? insLayer : t.layer, t.color === BYBLOCK ? insColor : t.color, p[0], p[1], p[2], t.h * scale, t.text);
      }
    }
    for (const ins of block.inserts) {
      // Compose: parent(m) o translate(-base) o child(ins.m)
      const c = ins.m;
      const n = new Float64Array(12);
      for (let r = 0; r < 3; r++) {
        const a = m[r * 4], b = m[r * 4 + 1], d = m[r * 4 + 2];
        n[r * 4] = a * c[0] + b * c[4] + d * c[8];
        n[r * 4 + 1] = a * c[1] + b * c[5] + d * c[9];
        n[r * 4 + 2] = a * c[2] + b * c[6] + d * c[10];
        n[r * 4 + 3] = a * (c[3] - bx) + b * (c[7] - by) + d * (c[11] - bz) + m[r * 4 + 3];
      }
      this.expand(ins.name, n, ins.layer === '0' ? insLayer : ins.layer, ins.color === BYBLOCK ? insColor : ins.color, depth + 1);
    }
  }
}

/** Binary DXF starts with this 22-byte sentinel. */
export function isBinaryDxf(head: Uint8Array): boolean {
  const sig = 'AutoCAD Binary DXF';
  if (head.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (head[i] !== sig.charCodeAt(i)) return false;
  return true;
}
