import { describe, expect, it } from 'vitest';
import { notesToCsv, notesToTsv, type Note } from '../src/ui/notes';

const head = { n: '№', date: 'Дата', x: 'X', y: 'Y', z: 'Z', layer: 'Слой', file: 'Файл', note: 'Заметка' };
const ts = new Date(2026, 10, 11, 9, 5).getTime();
const notes: Note[] = [
  { id: 'a', ts, text: 'Вывал кровли; закрепить', point: [654330.284, 7654619.156, 182.5], layer: '0', file: 'штольня.dxf' },
  { id: 'b', ts, text: 'Общая заметка\nвторая "строка"', point: null, layer: '', file: '' },
];

describe('notes export', () => {
  it('writes a CSV table with a BOM, quoting and two-decimal coordinates', () => {
    const csv = notesToCsv(notes, head, ';');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('№;Дата;X;Y;Z;Слой;Файл;Заметка');
    expect(lines[1]).toBe('1;2026-11-11 09:05;654330.28;7654619.16;182.50;0;штольня.dxf;"Вывал кровли; закрепить"');
    expect(lines[2]).toBe('2;2026-11-11 09:05;;;;;;"Общая заметка\nвторая ""строка"""');
  });
  it('uses the comma only where asked and quotes it', () => {
    const csv = notesToCsv([{ ...notes[0], text: 'a, b' }], head, ',');
    expect(csv).toContain(',"a, b"\r\n');
  });
  it('writes one line per note as tab-separated text', () => {
    const tsv = notesToTsv(notes, head).split('\n');
    expect(tsv.length).toBe(3);
    expect(tsv[2].split('\t')).toEqual(['2', '2026-11-11 09:05', '', '', '', '', '', 'Общая заметка вторая "строка"']);
  });
});
