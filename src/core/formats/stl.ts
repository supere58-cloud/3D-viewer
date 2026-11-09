/** Streaming STL reader, binary and ASCII. */
import { BYLAYER, type GeometrySink } from '../types';
import { LineSplitter, parseFloatBytes } from '../lines';

export class StlParser {
  private mode: 'unknown' | 'binary' | 'ascii' = 'unknown';
  private head = new Uint8Array(84);
  private headLen = 0;
  private rec = new Uint8Array(50);
  private recLen = 0;
  private recView = new DataView(this.rec.buffer);
  private splitter: LineSplitter;
  private tri = new Float64Array(9);
  private triLen = 0;
  private layer: string;
  triangles = 0;

  constructor(private sink: GeometrySink, defaultLayer: string, private totalBytes: number) {
    this.layer = defaultLayer;
    this.splitter = new LineSplitter((b, s, e) => this.line(b, s, e));
  }

  push(chunk: Uint8Array): void {
    let off = 0;
    if (this.mode === 'unknown') {
      const take = Math.min(84 - this.headLen, chunk.length);
      this.head.set(chunk.subarray(0, take), this.headLen);
      this.headLen += take;
      off = take;
      if (this.headLen < 84) return;
      this.decide();
      if (this.isAscii()) this.splitter.push(this.head);
    }
    if (this.isAscii()) {
      this.splitter.push(off === 0 ? chunk : chunk.subarray(off));
      return;
    }
    const n = chunk.length;
    while (off < n) {
      if (this.recLen === 0 && n - off >= 50) {
        this.emitBinary(new DataView(chunk.buffer, chunk.byteOffset + off, 50));
        off += 50;
        continue;
      }
      const take = Math.min(50 - this.recLen, n - off);
      this.rec.set(chunk.subarray(off, off + take), this.recLen);
      this.recLen += take;
      off += take;
      if (this.recLen === 50) {
        this.emitBinary(this.recView);
        this.recLen = 0;
      }
    }
  }

  private isAscii(): boolean {
    return this.mode === 'ascii';
  }

  finish(): void {
    if (this.mode === 'unknown') {
      // Shorter than a binary header: can only be (tiny) ASCII.
      this.mode = 'ascii';
      this.splitter.push(this.head.subarray(0, this.headLen));
    }
    if (this.mode === 'ascii') this.splitter.finish();
  }

  private decide(): void {
    const count = new DataView(this.head.buffer).getUint32(80, true);
    if (84 + count * 50 === this.totalBytes) { this.mode = 'binary'; return; }
    let s = 0;
    while (s < 80 && (this.head[s] === 32 || this.head[s] === 9 || this.head[s] === 10 || this.head[s] === 13)) s++;
    const word = String.fromCharCode(...this.head.subarray(s, s + 5)).toLowerCase();
    this.mode = word === 'solid' ? 'ascii' : 'binary';
  }

  private emitBinary(v: DataView): void {
    this.sink.tri(
      this.layer, BYLAYER,
      v.getFloat32(12, true), v.getFloat32(16, true), v.getFloat32(20, true),
      v.getFloat32(24, true), v.getFloat32(28, true), v.getFloat32(32, true),
      v.getFloat32(36, true), v.getFloat32(40, true), v.getFloat32(44, true),
    );
    this.triangles++;
  }

  private line(buf: Uint8Array, s: number, e: number): void {
    while (s < e && (buf[s] === 32 || buf[s] === 9)) s++;
    if (e - s < 6) return;
    const c = buf[s] | 32;
    if (c === 118 && (buf[s + 1] | 32) === 101) {
      // vertex x y z
      let i = s + 6;
      for (let k = 0; k < 3; k++) {
        while (i < e && (buf[i] === 32 || buf[i] === 9)) i++;
        let j = i;
        while (j < e && buf[j] !== 32 && buf[j] !== 9) j++;
        this.tri[this.triLen++] = j > i ? parseFloatBytes(buf, i, j) : NaN;
        i = j;
      }
      if (this.triLen === 9) {
        const t = this.tri;
        this.sink.tri(this.layer, BYLAYER, t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]);
        this.triangles++;
        this.triLen = 0;
      }
    } else if (c === 115 && (buf[s + 1] | 32) === 111) {
      // solid name
      const name = new TextDecoder().decode(buf.subarray(s + 5, e)).trim();
      if (name) this.layer = name;
    } else if (c === 101 && (buf[s + 3] | 32) === 102) {
      // endfacet: drop a facet that had the wrong number of vertices
      this.triLen = 0;
    }
  }
}
