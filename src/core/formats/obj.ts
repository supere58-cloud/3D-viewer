/**
 * Streaming Wavefront OBJ reader. Written by hand instead of using the
 * three.js loader because that one parses into float32, which loses about
 * half a metre on 7-digit mine coordinates.
 */
import { BYLAYER, type GeometrySink } from '../types';
import { LineSplitter, parseFloatBytes, parseIntBytes } from '../lines';

export class ObjParser {
  private splitter: LineSplitter;
  private verts: number[] = [];
  private layer: string;
  private idx: number[] = [];
  private utf8 = new TextDecoder('utf-8');
  badFaces = 0;
  statements: Record<string, number> = Object.create(null);

  constructor(private sink: GeometrySink, defaultLayer: string) {
    this.layer = defaultLayer;
    this.splitter = new LineSplitter((b, s, e) => this.line(b, s, e));
  }

  push(chunk: Uint8Array): void { this.splitter.push(chunk); }
  finish(): void { this.splitter.finish(); }

  private count(key: string): void {
    this.statements[key] = (this.statements[key] ?? 0) + 1;
  }

  private line(buf: Uint8Array, s: number, e: number): void {
    while (s < e && (buf[s] === 32 || buf[s] === 9)) s++;
    if (s >= e || buf[s] === 35) return;
    const c0 = buf[s];
    const c1 = s + 1 < e ? buf[s + 1] : 32;
    const sep = c1 === 32 || c1 === 9;
    if (c0 === 118 && sep) {
      // v x y z
      let i = s + 1;
      for (let k = 0; k < 3; k++) {
        while (i < e && (buf[i] === 32 || buf[i] === 9)) i++;
        let j = i;
        while (j < e && buf[j] !== 32 && buf[j] !== 9) j++;
        this.verts.push(j > i ? parseFloatBytes(buf, i, j) : NaN);
        i = j;
      }
      this.count('v');
      return;
    }
    if ((c0 === 102 || c0 === 108 || c0 === 112) && sep) {
      // f / l / p with index lists like 12/3/4 or -1
      const idx = this.idx;
      idx.length = 0;
      const nv = this.verts.length / 3;
      let i = s + 1;
      while (i < e) {
        while (i < e && (buf[i] === 32 || buf[i] === 9)) i++;
        let j = i;
        while (j < e && buf[j] !== 32 && buf[j] !== 9 && buf[j] !== 47) j++;
        if (j > i) {
          let v = parseIntBytes(buf, i, j);
          if (v < 0) v = nv + v + 1;
          if (!(v >= 1 && v <= nv)) { this.badFaces++; idx.length = 0; break; }
          idx.push((v - 1) * 3);
        }
        while (j < e && buf[j] !== 32 && buf[j] !== 9) j++;
        i = j;
      }
      const v = this.verts;
      const L = this.layer;
      if (c0 === 102) {
        this.count('f');
        for (let k = 2; k < idx.length; k++) {
          const a = idx[0], b = idx[k - 1], c = idx[k];
          this.sink.tri(L, BYLAYER, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]);
        }
      } else if (c0 === 108) {
        this.count('l');
        for (let k = 1; k < idx.length; k++) {
          const a = idx[k - 1], b = idx[k];
          this.sink.seg(L, BYLAYER, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2]);
        }
      } else {
        this.count('p');
        for (const a of idx) this.sink.point(L, BYLAYER, v[a], v[a + 1], v[a + 2]);
      }
      return;
    }
    if ((c0 === 111 || c0 === 103) && sep) {
      // o name / g name
      const name = this.utf8.decode(buf.subarray(s + 2, e)).trim();
      if (name) this.layer = name;
      this.count(c0 === 111 ? 'o' : 'g');
      return;
    }
    let j = s;
    while (j < e && buf[j] !== 32 && buf[j] !== 9) j++;
    let key = '';
    for (let i = s; i < j && i < s + 12; i++) key += String.fromCharCode(buf[i]);
    this.count(key);
  }
}
