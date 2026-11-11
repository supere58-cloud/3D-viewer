/** Field notes: free text, optionally tied to a true-coordinate point. */
import type { Vec3 } from '../core/types';

export interface Note {
  id: string;
  /** Creation time, ms since epoch. */
  ts: number;
  text: string;
  /** True coordinates, or null for a general note. */
  point: Vec3 | null;
  layer: string;
  file: string;
}

export interface NoteHeaders { n: string; date: string; x: string; y: string; z: string; layer: string; file: string; note: string }

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rows(notes: Note[], head: NoteHeaders): string[][] {
  const out = [[head.n, head.date, head.x, head.y, head.z, head.layer, head.file, head.note]];
  notes.forEach((n, i) => {
    out.push([
      String(i + 1), formatDate(n.ts),
      n.point ? n.point[0].toFixed(2) : '', n.point ? n.point[1].toFixed(2) : '', n.point ? n.point[2].toFixed(2) : '',
      n.layer, n.file, n.text,
    ]);
  });
  return out;
}

/**
 * CSV for spreadsheets. Starts with a byte-order mark so Excel reads Cyrillic,
 * and uses the separator Excel expects for the language (";" for Russian).
 * Numbers keep a decimal point so Micromine and GIS tools import them as is.
 */
export function notesToCsv(notes: Note[], head: NoteHeaders, separator: ',' | ';'): string {
  const cell = (s: string): string => (/["\r\n]/.test(s) || s.includes(separator) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  return '﻿' + rows(notes, head).map((r) => r.map(cell).join(separator)).join('\r\n') + '\r\n';
}

/** Tab-separated text: pastes straight into spreadsheet cells. */
export function notesToTsv(notes: Note[], head: NoteHeaders): string {
  const cell = (s: string): string => s.replace(/[\t\r\n]+/g, ' ');
  return rows(notes, head).map((r) => r.map(cell).join('\t')).join('\n');
}
