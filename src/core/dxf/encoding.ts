/**
 * DXF string decoding.
 *
 * Rule: strict UTF-8 first; if the bytes are not valid UTF-8, fall back to the
 * code page from $DWGCODEPAGE, and to Windows-1251 when the header does not
 * name one (the files come from Russian-language Micromine installs).
 * Decoding is per string so the file can be streamed.
 */

const DEFAULT_LEGACY = 'windows-1251';

/** Maps a $DWGCODEPAGE value to a WHATWG encoding label, or null. */
export function codepageToLabel(codepage: string): string | null {
  const cp = codepage.trim().toUpperCase().replace(/[\s-]/g, '_');
  const m = /^(?:ANSI|WINDOWS|CP|DOS)?_?(\d{3,5})$/.exec(cp);
  if (m) {
    switch (m[1]) {
      case '874': return 'windows-874';
      case '932': return 'shift_jis';
      case '936': return 'gbk';
      case '949': return 'euc-kr';
      case '950': return 'big5';
      case '866': return 'ibm866';
      case '65001': return 'utf-8';
      case '1250': case '1251': case '1252': case '1253': case '1254':
      case '1255': case '1256': case '1257': case '1258':
        return 'windows-' + m[1];
      default: return null;
    }
  }
  if (cp === 'UTF_8' || cp === 'UTF8') return 'utf-8';
  if (cp === 'KOI8_R') return 'koi8-r';
  if (cp === 'KOI8_U') return 'koi8-u';
  return null;
}

function makeDecoder(label: string, fatal: boolean): TextDecoder | null {
  try {
    return new TextDecoder(label, { fatal });
  } catch {
    return null;
  }
}

export class DxfStringDecoder {
  private utf8 = new TextDecoder('utf-8', { fatal: true });
  private legacy: TextDecoder;
  private legacyLabel: string;
  private sawUtf8 = false;
  private sawLegacy = false;

  constructor() {
    this.legacyLabel = DEFAULT_LEGACY;
    this.legacy = makeDecoder(DEFAULT_LEGACY, false) ?? new TextDecoder('utf-8');
  }

  /** Called when $DWGCODEPAGE is read from the header. */
  setCodepage(codepage: string): void {
    const label = codepageToLabel(codepage);
    if (!label || label === 'utf-8') return;
    const dec = makeDecoder(label, false);
    if (dec) {
      this.legacy = dec;
      this.legacyLabel = label;
    }
  }

  /** Label of what was actually used: ASCII, UTF-8, a code page, or a mix. */
  get detected(): string {
    if (this.sawLegacy && this.sawUtf8) return `${this.legacyLabel} + UTF-8`;
    if (this.sawLegacy) return this.legacyLabel;
    if (this.sawUtf8) return 'UTF-8';
    return 'ASCII';
  }

  decode(buf: Uint8Array, start: number, end: number): string {
    while (start < end && (buf[start] === 32 || buf[start] === 9)) start++;
    while (end > start && (buf[end - 1] === 32 || buf[end - 1] === 9)) end--;
    let ascii = true;
    let hasBackslash = false;
    for (let i = start; i < end; i++) {
      const b = buf[i];
      if (b >= 128) { ascii = false; break; }
      if (b === 92) hasBackslash = true;
    }
    let s: string;
    if (ascii) {
      s = '';
      for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
      return hasBackslash ? decodeUnicodeEscapes(s) : s;
    }
    const view = buf.subarray(start, end);
    try {
      s = this.utf8.decode(view);
      this.sawUtf8 = true;
    } catch {
      s = this.legacy.decode(view);
      this.sawLegacy = true;
    }
    return decodeUnicodeEscapes(s);
  }
}

/** \U+XXXX (and the \M+NXXXX multibyte form, which is dropped). */
export function decodeUnicodeEscapes(s: string): string {
  if (s.indexOf('\\') < 0) return s;
  return s
    .replace(/\\[Uu]\+([0-9A-Fa-f]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\[Mm]\+[0-9A-Fa-f]{5}/g, '�');
}

/** %%c, %%d, %%p, %%u, %%o, %%nnn control codes used by TEXT and MTEXT. */
export function decodeControlCodes(s: string): string {
  if (s.indexOf('%%') < 0) return s;
  return s.replace(/%%(\d{3}|.)/g, (_m, g: string) => {
    if (g.length === 3) return String.fromCharCode(parseInt(g, 10));
    switch (g.toLowerCase()) {
      case 'c': return 'Ø';
      case 'd': return '°';
      case 'p': return '±';
      case 'u': case 'o': case 'k': return '';
      case '%': return '%';
      default: return g;
    }
  });
}

/** Strips MTEXT inline formatting and returns plain text with \n line breaks. */
export function decodeMText(raw: string): string {
  let out = '';
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const ch = raw[i];
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') { out += ch; continue; }
    i++;
    if (i >= n) break;
    const c = raw[i];
    switch (c) {
      case '\\': case '{': case '}': out += c; break;
      case 'P': case 'X': out += '\n'; break;
      case 'N': out += '\n'; break;
      case '~': out += ' '; break;
      case 'L': case 'l': case 'O': case 'o': case 'K': case 'k': break;
      case 'S': {
        // Stacked text: \Snum^den; or \Snum/den; or \Snum#den;
        const endIdx = raw.indexOf(';', i);
        const body = endIdx < 0 ? raw.slice(i + 1) : raw.slice(i + 1, endIdx);
        out += body.replace(/[\^#]/, '/').replace(/\\(.)/g, '$1');
        i = endIdx < 0 ? n : endIdx;
        break;
      }
      case 'f': case 'F': case 'H': case 'h': case 'C': case 'c': case 'T': case 'Q': case 'W':
      case 'A': case 'p': {
        const endIdx = raw.indexOf(';', i);
        i = endIdx < 0 ? n : endIdx;
        break;
      }
      default:
        // Unknown escape: keep the character, drop the backslash.
        out += c;
    }
  }
  return decodeControlCodes(out).replace(/\r/g, '').trim();
}

export function decodePlainText(raw: string): string {
  return decodeControlCodes(raw).trim();
}
