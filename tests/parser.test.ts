import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadFromBytes } from '../src/core/load';
import { LoadError, type ParsedLayer, type ParsedModel } from '../src/core/types';
import { parseFloatBytes, parseIntBytes } from '../src/core/lines';
import { aciToRgb } from '../src/core/dxf/aci';
import { codepageToLabel, decodeMText, decodePlainText } from '../src/core/dxf/encoding';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', name)));
const load = (name: string, chunk = 0): ParsedModel => loadFromBytes(name, fixture(name), chunk);
const layer = (m: ParsedModel, name: string): ParsedLayer => {
  const l = m.layers.find((x) => x.name === name);
  if (!l) throw new Error(`layer ${name} not found; have ${m.layers.map((x) => x.name).join(', ')}`);
  return l;
};
/** True coordinates of vertex i of a primitive set. */
const vertex = (m: ParsedModel, pos: Float32Array, i: number): number[] => [
  m.origin[0] + pos[i * 3], m.origin[1] + pos[i * 3 + 1], m.origin[2] + pos[i * 3 + 2],
];
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('number parsing', () => {
  it('matches parseFloat exactly', () => {
    const cases = ['0', '-0.0', '6543210.123456', '17654321.987654', '1.5E+02', '-5.0e1', '  42.5  ', '.5', '5.', '+3.25',
      '0.000001', '123456789012345678', '1e-7', '7654321.995', '1.0D+03', '1e400'];
    for (const c of cases) {
      const b = bytes(c);
      expect(parseFloatBytes(b, 0, b.length), c).toBe(parseFloat(c.trim().replace(/[dD]/, 'e')));
    }
    for (let i = 0; i < 2000; i++) {
      const s = (Math.random() * 2e7 - 1e7).toFixed(Math.floor(Math.random() * 9));
      const b = bytes(s);
      expect(parseFloatBytes(b, 0, b.length), s).toBe(parseFloat(s));
    }
  });
  it('rejects non-numbers', () => {
    for (const c of ['', 'abc', '-', '1.2.3', '12abc']) {
      const b = bytes(c);
      expect(Number.isNaN(parseFloatBytes(b, 0, b.length)), c).toBe(true);
    }
    expect(parseIntBytes(bytes(' 70 '), 0, 4)).toBe(70);
    expect(parseIntBytes(bytes('8.0'), 0, 3)).toBe(8);
    expect(Number.isNaN(parseIntBytes(bytes('LINE'), 0, 4))).toBe(true);
  });
});

describe('text decoding', () => {
  it('maps code pages', () => {
    expect(codepageToLabel('ANSI_1251')).toBe('windows-1251');
    expect(codepageToLabel('ansi_1252')).toBe('windows-1252');
    expect(codepageToLabel('ANSI_936')).toBe('gbk');
    expect(codepageToLabel('nonsense')).toBeNull();
  });
  it('decodes control codes and MTEXT formatting', () => {
    expect(decodePlainText('%%c76 45%%d %%p0.5 %%uunder%%u 100%%%')).toBe('\u00D876 45\u00B0 \u00B10.5 under 100%');
    expect(decodeMText('{\\fArial|b0;\\H2.5;Line 1}\\PLine\\~2 \\S1/2; \\\\ \\{x\\}')).toBe('Line 1\nLine\u00A02 1/2 \\ {x}');
    expect(decodeMText('\\A1;\\C3;Text')).toBe('Text');
  });
  it('has the standard ACI colours', () => {
    expect(aciToRgb(1)).toBe(0xff0000);
    expect(aciToRgb(3)).toBe(0x00ff00);
    expect(aciToRgb(7)).toBe(0xffffff);
    expect(aciToRgb(30)).toBe(0xff7f00);
    expect(aciToRgb(11)).toBe(0xff7f7f);
    expect(aciToRgb(250)).toBe(0x333333);
  });
});

describe('DXF: Windows-1251', () => {
  const m = load('cp1251.dxf');
  it('detects the encoding and version', () => {
    expect(m.diagnostics.encoding).toBe('windows-1251');
    expect(m.diagnostics.codepage).toBe('ANSI_1251');
    expect(m.diagnostics.version).toBe('AC1015');
    expect(m.diagnostics.warnings).toEqual([]);
  });
  it('reads Cyrillic layer names and BYLAYER colours', () => {
    expect(m.layers.map((l) => l.name)).toEqual(['Рудное тело', 'Скважины', 'Подписи']);
    expect(layer(m, 'Рудное тело').color).toBe(0xff0000);
    expect(layer(m, 'Скважины').color).toBe(0x00ff00);
    expect(layer(m, 'Рудное тело').tri?.col).toBeNull();
  });
  it('drops the repeated fourth corner of a 3DFACE', () => {
    expect(m.diagnostics.triangles).toBe(1);
    expect(m.diagnostics.segments).toBe(1);
  });
  it('decodes TEXT, MTEXT and \\U+ escapes', () => {
    expect(m.labels.text).toEqual(['Скв. №12 \u00D876 45\u00B0 \u00B10.5', 'Забой\nГлубина \u0394=150 м', 'Штольня']);
    expect(Array.from(m.labels.height)).toEqual([2.5, 1.5, 2]);
  });
  it('gives the same result when streamed in tiny chunks', () => {
    for (const size of [1, 7, 64]) {
      const s = load('cp1251.dxf', size);
      expect(s.labels.text).toEqual(m.labels.text);
      expect(s.layers.map((l) => l.name)).toEqual(m.layers.map((l) => l.name));
      expect(Array.from(layer(s, 'Рудное тело').tri!.pos)).toEqual(Array.from(layer(m, 'Рудное тело').tri!.pos));
    }
  });
});

describe('DXF: UTF-8', () => {
  const m = load('utf8.dxf');
  it('prefers UTF-8 even when the header names a code page', () => {
    expect(m.diagnostics.encoding).toBe('UTF-8');
    expect(m.layers[0].name).toBe('Рудное тело');
    expect(m.labels.text).toEqual(['Штольня 5']);
  });
  it('uses the layer true colour (420) and splits a quad', () => {
    expect(m.layers[0].color).toBe(0x12ab34);
    expect(m.diagnostics.triangles).toBe(2);
  });
});

describe('DXF: polyface and friends', () => {
  const m = load('polyface.dxf');
  it('builds a polyface mesh with per-face colour', () => {
    const mesh = layer(m, 'MESH');
    expect(mesh.tri!.pos.length).toBe(5 * 9);
    expect(mesh.tri!.col).not.toBeNull();
    // third face is red, the others take the layer colour
    const col = mesh.tri!.col!;
    expect(Array.from(col.subarray(18, 21))).toEqual([255, 0, 0]);
    expect(Array.from(col.subarray(0, 3))).toEqual([(mesh.color >> 16) & 255, (mesh.color >> 8) & 255, mesh.color & 255]);
    // first face is 1-2-5 => apex (5,5,8) is its third vertex
    expect(vertex(m, mesh.tri!.pos, 2)).toEqual([5, 5, 8]);
  });
  it('builds a polygon mesh', () => {
    expect(layer(m, 'GRID').tri!.pos.length).toBe(8 * 9);
  });
  it('closes a 3D polyline', () => {
    const s = layer(m, 'STRING').seg!;
    expect(s.pos.length).toBe(3 * 6);
    expect(vertex(m, s.pos, 4)).toEqual([0, 10, 10]);
    expect(vertex(m, s.pos, 5)).toEqual([0, 0, 0]);
  });
  it('applies LWPOLYLINE elevation', () => {
    const s = layer(m, 'CONTOUR').seg!;
    expect(s.pos.length).toBe(4 * 6);
    for (let i = 0; i < 8; i++) expect(vertex(m, s.pos, i)[2]).toBe(125.5);
  });
  it('reads points with entity colour', () => {
    const p = layer(m, 'PTS');
    expect(vertex(m, p.pt!.pos, 0)).toEqual([1, 2, 3]);
    expect(p.color).toBe(0x0000ff);
  });
  it('skips and counts unknown entities', () => {
    expect(m.diagnostics.skipped).toEqual({ SPLINE: 2, HATCH: 1 });
    expect(m.diagnostics.entities.VERTEX).toBe(21);
    expect(m.diagnostics.entities.POLYLINE).toBe(3);
    expect(m.diagnostics.version).toBe('AC1009');
    expect(m.diagnostics.encoding).toBe('ASCII');
  });
  it('reports the bounding box', () => {
    expect(m.diagnostics.bbox).toEqual({ min: [0, 0, 0], max: [110, 10, 125.5] });
  });
});

describe('DXF: large coordinates', () => {
  const m = load('large_coords.dxf');
  it('keeps true coordinates to well under a millimetre', () => {
    const t = layer(m, 'PIT').tri!.pos;
    const expected = [[6543210.123456, 17654321.987654, 1234.5678], [6543215.5, 17654321.25, 1234.125], [6543215.5, 17654326.75, 1230.0625]];
    expected.forEach((e, i) => vertex(m, t, i).forEach((v, k) => expect(Math.abs(v - e[k])).toBeLessThan(6e-4)));
    const p = vertex(m, layer(m, 'SURVEY').pt!.pos, 0);
    expect(Math.abs(p[0] - 6543210.005)).toBeLessThan(6e-4);
    expect(Math.abs(p[1] - 17654321.995)).toBeLessThan(6e-4);
    expect(Math.abs(p[2] + 0.004)).toBeLessThan(6e-4);
  });
  it('parses exponent notation', () => {
    const s = layer(m, 'DH').seg!.pos;
    expect(vertex(m, s, 0)[2]).toBe(150);
    expect(vertex(m, s, 1)[2]).toBe(-50);
  });
  it('is not thrown off by a stray entity at 0,0', () => {
    expect(Math.abs(m.origin[0] - 6543210)).toBeLessThan(20000);
    expect(m.diagnostics.warnings).toContain('farOutliers');
    expect(m.diagnostics.bbox!.min).toEqual([0, 0, -50]);
    // The framing box ignores the outlier.
    expect(m.focus!.min[0]).toBeGreaterThan(6543000);
    expect(m.focus!.min[1]).toBeGreaterThan(17654000);
  });
  it('accepts LF line ends and a file without HEADER', () => {
    expect(m.diagnostics.version).toBeNull();
    expect(m.diagnostics.malformedLines).toBe(0);
  });
});

describe('DXF: damaged input', () => {
  it('keeps complete entities of a truncated file', () => {
    const m = load('truncated.dxf');
    expect(m.diagnostics.warnings).toContain('truncated');
    expect(m.diagnostics.triangles).toBe(2);
    // The half-read third face must not leak into the bounding box.
    expect(m.diagnostics.bbox).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });
  it('survives truncation at every byte offset', () => {
    const data = fixture('polyface.dxf');
    for (let cut = 1; cut < data.length; cut += 13) {
      let model: ParsedModel | null = null;
      try {
        model = loadFromBytes('cut.dxf', data.subarray(0, cut));
      } catch (e) {
        expect(e).toBeInstanceOf(LoadError);
        continue;
      }
      expect(model.diagnostics.triangles).toBeLessThanOrEqual(13);
    }
  });
  it('resynchronises after garbage lines', () => {
    const text = '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nA\ngarbage line\n10\n1\n20\n2\n30\n3\n11\n4\n21\n5\n31\n6\n0\nLINE\n8\nA\n10\nNaN\n20\n0\n30\n0\n11\n1\n21\n1\n31\n1\n0\nENDSEC\n0\nEOF\n';
    const m = loadFromBytes('x.dxf', bytes(text));
    expect(m.diagnostics.segments).toBe(1);
    expect(m.diagnostics.malformedLines).toBeGreaterThan(0);
    expect(m.diagnostics.warnings).toContain('malformedLines');
    expect(m.diagnostics.skipped['(malformed)']).toBe(1);
  });
  it('reports a missing EOF separately from truncation', () => {
    const m = loadFromBytes('x.dxf', bytes('0\nSECTION\n2\nENTITIES\n0\nPOINT\n10\n1\n20\n1\n30\n1\n0\nENDSEC\n'));
    expect(m.diagnostics.warnings).toEqual(['noEof']);
    expect(m.diagnostics.points).toBe(1);
  });
  it('detects binary DXF', () => {
    expect(() => load('binary.dxf')).toThrowError(expect.objectContaining({ code: 'binaryDxf' }));
  });
  it('detects UTF-16 and non-DXF content', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x30, 0, 0x0d, 0, 0x0a, 0]);
    expect(() => loadFromBytes('a.dxf', utf16)).toThrowError(expect.objectContaining({ code: 'utf16Dxf' }));
    expect(() => loadFromBytes('a.dxf', bytes('hello world\nthis is not a drawing\n'))).toThrowError(expect.objectContaining({ code: 'notDxf' }));
    expect(() => loadFromBytes('a.xyz', bytes('hello'))).toThrowError(expect.objectContaining({ code: 'unsupportedFormat' }));
  });
});

describe('DXF: blocks', () => {
  const m = load('blocks.dxf');
  it('expands nested INSERTs with scale, rotation and base point', () => {
    const s = layer(m, 'COLLARS').seg!.pos;
    const a = vertex(m, s, 0), b = vertex(m, s, 1);
    [1000, 2010, 300].forEach((v, k) => expect(a[k]).toBeCloseTo(v, 6));
    [1000, 2012, 300].forEach((v, k) => expect(b[k]).toBeCloseTo(v, 6));
  });
  it('inherits layer 0 and BYBLOCK from the INSERT, keeps explicit ones', () => {
    expect(layer(m, 'COLLARS').color).toBe(0xff0000);
    expect(layer(m, 'FIXED').color).toBe(0x00ff00);
    expect(m.layers.some((l) => l.name === '0')).toBe(false);
  });
  it('warns about a missing block', () => {
    expect(m.diagnostics.warnings).toContain('missingBlocks');
    expect(m.diagnostics.blocks).toBe(2);
  });
});

describe('other formats', () => {
  it('reads OBJ in float64 with fan triangulation and negative indices', () => {
    const m = load('model.obj');
    const shell = layer(m, 'Pit shell');
    expect(shell.tri!.pos.length).toBe(2 * 9);
    const v = vertex(m, shell.tri!.pos, 0);
    expect(v[0]).toBeCloseTo(6543210.125, 3);
    expect(v[1]).toBeCloseTo(17654321.5, 3);
    expect(layer(m, 'Strings').seg!.pos.length).toBe(2 * 6);
    expect(m.diagnostics.warnings).toContain('badFaces');
    expect(m.diagnostics.skipped.vn).toBe(1);
  });
  it('reads ASCII STL', () => {
    const m = load('ascii.stl');
    expect(m.layers[0].name).toBe('stope');
    expect(vertex(m, m.layers[0].tri!.pos, 2)).toEqual([654322.5, 7654322.25, 10.5]);
  });
  it('reads binary STL even when the header says "solid"', () => {
    for (const chunk of [0, 33]) {
      const m = load('binary.stl', chunk);
      expect(m.diagnostics.triangles).toBe(2);
      expect(vertex(m, m.layers[0].tri!.pos, 5)).toEqual([1, 1, 5]);
    }
  });
  it('reads GLB, applies node transforms and converts Y-up to Z-up', () => {
    const m = load('model.glb');
    const l = layer(m, 'Decline');
    expect(l.color).toBe(0xff8000);
    // glTF (0,2,0) + (100,50,-200) = (100,52,-200) => Z-up (100, 200, 52)
    expect(vertex(m, l.tri!.pos, 2)).toEqual([100, 200, 52]);
  });
});
