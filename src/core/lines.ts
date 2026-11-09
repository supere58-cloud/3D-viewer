/**
 * Splits a stream of byte chunks into lines without ever building one big
 * string. Handles LF, CRLF and lone CR line ends. A line that straddles two
 * chunks is assembled in a small carry buffer.
 */
export type LineHandler = (buf: Uint8Array, start: number, end: number) => void;

export class LineSplitter {
  private carry: Uint8Array = new Uint8Array(256);
  private carryLen = 0;
  private lastWasCR = false;

  constructor(private onLine: LineHandler) {}

  push(chunk: Uint8Array): void {
    const n = chunk.length;
    let i = 0;
    // A CR at the end of the previous chunk followed by LF here is one break.
    if (this.lastWasCR && n > 0 && chunk[0] === 10) i = 1;
    this.lastWasCR = false;
    let lineStart = i;
    for (; i < n; i++) {
      const b = chunk[i];
      if (b !== 10 && b !== 13) continue;
      if (this.carryLen > 0) {
        this.appendCarry(chunk, lineStart, i);
        const len = this.carryLen;
        this.carryLen = 0;
        this.onLine(this.carry, 0, len);
      } else {
        this.onLine(chunk, lineStart, i);
      }
      if (b === 13) {
        if (i + 1 < n) {
          if (chunk[i + 1] === 10) i++;
        } else {
          this.lastWasCR = true;
        }
      }
      lineStart = i + 1;
    }
    if (lineStart < n) this.appendCarry(chunk, lineStart, n);
  }

  /** Flush the last line if the stream did not end with a line break. */
  finish(): void {
    if (this.carryLen > 0) {
      const len = this.carryLen;
      this.carryLen = 0;
      this.onLine(this.carry, 0, len);
    }
  }

  private appendCarry(src: Uint8Array, start: number, end: number): void {
    const add = end - start;
    if (this.carryLen + add > this.carry.length) {
      const grown = new Uint8Array(Math.max(this.carry.length * 2, this.carryLen + add));
      grown.set(this.carry.subarray(0, this.carryLen));
      this.carry = grown;
    }
    this.carry.set(src.subarray(start, end), this.carryLen);
    this.carryLen += add;
  }
}

const POW10 = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19,
  1e20, 1e21, 1e22,
];

function slowFloat(buf: Uint8Array, start: number, end: number): number {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
  // Fortran-style exponents (1.5D+03) appear in some exporters.
  s = s.trim().replace(/[dD]/, 'e').replace(',', '.');
  // parseFloat alone would accept a numeric prefix of garbage ("1.2.3").
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? parseFloat(s) : NaN;
}

/**
 * Parses an ASCII decimal number straight from bytes. Returns NaN if the
 * text is not a number. The fast path (<= 15 significant digits, small
 * exponent) is exact: an integer below 2^53 scaled by an exact power of ten
 * with one correctly rounded operation. Anything else goes to parseFloat.
 */
export function parseFloatBytes(buf: Uint8Array, start: number, end: number): number {
  let i = start;
  while (i < end && (buf[i] === 32 || buf[i] === 9)) i++;
  while (end > i && (buf[end - 1] === 32 || buf[end - 1] === 9)) end--;
  if (i >= end) return NaN;
  const numStart = i;
  let neg = false;
  if (buf[i] === 45) { neg = true; i++; } else if (buf[i] === 43) i++;
  let mant = 0;
  let digits = 0;
  let scale = 0;
  let any = false;
  for (; i < end; i++) {
    const d = buf[i] - 48;
    if (d < 0 || d > 9) break;
    any = true;
    if (mant !== 0 || d !== 0) digits++;
    mant = mant * 10 + d;
  }
  if (i < end && buf[i] === 46) {
    i++;
    for (; i < end; i++) {
      const d = buf[i] - 48;
      if (d < 0 || d > 9) break;
      any = true;
      if (mant !== 0 || d !== 0) digits++;
      mant = mant * 10 + d;
      scale++;
    }
  }
  if (!any) return NaN;
  if (i < end) {
    const c = buf[i];
    if (c === 101 || c === 69) {
      i++;
      let eneg = false;
      if (i < end && buf[i] === 45) { eneg = true; i++; } else if (i < end && buf[i] === 43) i++;
      let ex = 0;
      let anyE = false;
      for (; i < end; i++) {
        const d = buf[i] - 48;
        if (d < 0 || d > 9) break;
        anyE = true;
        if (ex < 10000) ex = ex * 10 + d;
      }
      if (!anyE || i < end) return slowFloat(buf, numStart, end);
      scale -= eneg ? -ex : ex;
    } else {
      return slowFloat(buf, numStart, end);
    }
  }
  if (digits > 15) return slowFloat(buf, numStart, end);
  let v: number;
  if (scale === 0) v = mant;
  else if (scale > 0 && scale <= 22) v = mant / POW10[scale];
  else if (scale < 0 && scale >= -22) {
    v = mant * POW10[-scale];
    if (v > 9007199254740992) return slowFloat(buf, numStart, end);
  } else return slowFloat(buf, numStart, end);
  return neg ? -v : v;
}

/** Parses an integer; returns NaN if the bytes are not an integer. */
export function parseIntBytes(buf: Uint8Array, start: number, end: number): number {
  let i = start;
  while (i < end && (buf[i] === 32 || buf[i] === 9)) i++;
  while (end > i && (buf[end - 1] === 32 || buf[end - 1] === 9)) end--;
  if (i >= end) return NaN;
  let neg = false;
  if (buf[i] === 45) { neg = true; i++; } else if (buf[i] === 43) i++;
  if (i >= end) return NaN;
  let v = 0;
  for (; i < end; i++) {
    const d = buf[i] - 48;
    if (d < 0 || d > 9) {
      // Tolerate "70.0"-style integers written as floats.
      if (buf[i] === 46) {
        for (let j = i + 1; j < end; j++) if (buf[j] !== 48) return NaN;
        break;
      }
      return NaN;
    }
    v = v * 10 + d;
  }
  return neg ? -v : v;
}

/** Fast ASCII-only bytes to string. */
export function asciiString(buf: Uint8Array, start: number, end: number): string {
  while (start < end && (buf[start] === 32 || buf[start] === 9)) start++;
  while (end > start && (buf[end - 1] === 32 || buf[end - 1] === 9)) end--;
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
  return s;
}
