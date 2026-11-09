// Generates the DXF/OBJ/STL/GLB fixtures used by the unit tests.
// Run: npm run fixtures   (the output is committed; re-run only to change it)
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
mkdirSync(dir, { recursive: true });

const pairs = (list) => list.map(([c, v]) => `${String(c).padStart(3)}\r\n${v}\r\n`).join('');
const section = (name, body) => pairs([[0, 'SECTION'], [2, name]]) + body + pairs([[0, 'ENDSEC']]);
const header = (ver, cp) => section('HEADER', pairs([[9, '$ACADVER'], [1, ver], ...(cp ? [[9, '$DWGCODEPAGE'], [3, cp]] : [])]));
const layerTable = (layers) =>
  section('TABLES', pairs([[0, 'TABLE'], [2, 'LAYER'], [70, layers.length]]) +
    layers.map((l) => pairs([[0, 'LAYER'], [2, l.name], [70, l.flags ?? 0], [62, l.color], ...(l.true !== undefined ? [[420, l.true]] : []), [6, 'CONTINUOUS']])).join('') +
    pairs([[0, 'ENDTAB']]));
const face = (layer, pts, extra = []) =>
  pairs([[0, '3DFACE'], [8, layer], ...extra, ...pts.flatMap((p, i) => [[10 + i, p[0]], [20 + i, p[1]], [30 + i, p[2]]])]);
const eof = pairs([[0, 'EOF']]);

// CP1251 encoder for the characters we use.
function cp1251(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 128) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else if (c === 0x2116) out.push(0xb9);
    else throw new Error('no cp1251 mapping for ' + ch);
  }
  return Buffer.from(out);
}

// 1. Windows-1251 file: Cyrillic layer names, TEXT, MTEXT, escapes.
{
  const body =
    header('AC1015', 'ANSI_1251') +
    layerTable([{ name: 'Рудное тело', color: 1 }, { name: 'Скважины', color: 3 }, { name: 'Подписи', color: 2 }]) +
    section('ENTITIES',
      face('Рудное тело', [[654321.12, 7654321.34, -125.5], [654331.12, 7654321.34, -125.5], [654331.12, 7654331.34, -120.25], [654331.12, 7654331.34, -120.25]]) +
      pairs([[0, 'LINE'], [8, 'Скважины'], [10, 654300], [20, 7654300], [30, 250], [11, 654310], [21, 7654310], [31, 100]]) +
      pairs([[0, 'TEXT'], [8, 'Подписи'], [10, 654300], [20, 7654300], [30, 250], [40, 2.5], [1, 'Скв. №12 %%c76 45%%d %%p0.5']]) +
      pairs([[0, 'MTEXT'], [8, 'Подписи'], [10, 654310], [20, 7654310], [30, 100], [40, 1.5], [1, '{\\fArial|b0|i0;Забой\\PГлубина \\U+0394=150 м}']]) +
      pairs([[0, 'TEXT'], [8, 'Подписи'], [10, 654305], [20, 7654305], [30, 0], [40, 2], [1, '\\U+0428\\U+0442\\U+043E\\U+043B\\U+044C\\U+043D\\U+044F']])) +
    eof;
  writeFileSync(path.join(dir, 'cp1251.dxf'), cp1251(body));
}

// 2. Same strings as UTF-8 (2007+ style).
{
  const body =
    header('AC1027', 'ANSI_1251') +
    layerTable([{ name: 'Рудное тело', color: 256, true: 0x12ab34 }]) +
    section('ENTITIES',
      face('Рудное тело', [[10, 20, 30], [11, 20, 30], [11, 21, 30], [10, 21, 30]]) +
      pairs([[0, 'TEXT'], [8, 'Рудное тело'], [10, 10], [20, 20], [30, 30], [40, 1], [1, 'Штольня 5']])) +
    eof;
  writeFileSync(path.join(dir, 'utf8.dxf'), Buffer.from('﻿' + body, 'utf8'));
}

// 3. Polyface mesh, polygon mesh, 3D polyline, LWPOLYLINE with elevation, POINT.
{
  const vert = (x, y, z, flags) => pairs([[0, 'VERTEX'], [8, 'MESH'], [10, x], [20, y], [30, z], [70, flags]]);
  const fvert = (a, b, c, d, extra = []) =>
    pairs([[0, 'VERTEX'], [8, 'MESH'], ...extra, [10, 0], [20, 0], [30, 0], [70, 128], [71, a], [72, b], [73, c], ...(d ? [[74, d]] : [])]);
  const polyface =
    pairs([[0, 'POLYLINE'], [8, 'MESH'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 64], [71, 5], [72, 4]]) +
    vert(0, 0, 0, 192) + vert(10, 0, 0, 192) + vert(10, 10, 0, 192) + vert(0, 10, 0, 192) + vert(5, 5, 8, 192) +
    fvert(1, 2, 5) + fvert(2, 3, 5) + fvert(3, -4, 5, 0, [[62, 1]]) + fvert(1, 2, 3, 4) +
    pairs([[0, 'SEQEND']]);
  // 3 x 3 polygon mesh => 4 quads => 8 triangles
  let grid = pairs([[0, 'POLYLINE'], [8, 'GRID'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 16], [71, 3], [72, 3]]);
  for (let m = 0; m < 3; m++) for (let n = 0; n < 3; n++) grid += pairs([[0, 'VERTEX'], [8, 'GRID'], [10, 100 + m * 5], [20, n * 5], [30, m + n], [70, 64]]);
  grid += pairs([[0, 'SEQEND']]);
  const poly3d =
    pairs([[0, 'POLYLINE'], [8, 'STRING'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 9]]) +
    [[0, 0, 0], [0, 0, 10], [0, 10, 10]].map((p) => pairs([[0, 'VERTEX'], [8, 'STRING'], [10, p[0]], [20, p[1]], [30, p[2]], [70, 32]])).join('') +
    pairs([[0, 'SEQEND']]);
  const lw = pairs([[0, 'LWPOLYLINE'], [8, 'CONTOUR'], [90, 4], [70, 1], [38, 125.5], [10, 0], [20, 0], [10, 4], [20, 0], [10, 4], [20, 4], [10, 0], [20, 4]]);
  const pt = pairs([[0, 'POINT'], [8, 'PTS'], [62, 5], [10, 1], [20, 2], [30, 3]]);
  const unknown = pairs([[0, 'SPLINE'], [8, 'X'], [70, 8], [10, 1], [20, 1], [30, 1]]) + pairs([[0, 'HATCH'], [8, 'X']]) + pairs([[0, 'SPLINE'], [8, 'X']]);
  writeFileSync(path.join(dir, 'polyface.dxf'), header('AC1009') + section('ENTITIES', polyface + grid + poly3d + lw + pt + unknown) + eof);
}

// 4. Large coordinates with long decimals, LF line ends, no HEADER (R12-minimal).
{
  const body =
    section('ENTITIES',
      // A stray entity at the drawing origin must not spoil precision or framing.
      pairs([[0, 'POINT'], [8, 'JUNK'], [10, 0], [20, 0], [30, 0]]) +
      face('PIT', [[6543210.123456, 17654321.987654, 1234.5678], [6543215.5, 17654321.25, 1234.125], [6543215.5, 17654326.75, 1230.0625]]) +
      pairs([[0, 'LINE'], [8, 'DH'], [10, '6543210.01'], [20, '17654321.02'], [30, '1.5E+02'], [11, '6543210.03'], [21, '17654321.04'], [31, '-5.0e1']]) +
      pairs([[0, 'POINT'], [8, 'SURVEY'], [10, '  6543210.005'], [20, '17654321.995'], [30, '-0.004']])) +
    eof;
  writeFileSync(path.join(dir, 'large_coords.dxf'), body.replace(/\r\n/g, '\n'));
}

// 5. Truncated in the middle of the third face.
{
  const full =
    header('AC1015') +
    section('ENTITIES',
      face('A', [[0, 0, 0], [1, 0, 0], [1, 1, 0]]) +
      face('A', [[0, 0, 1], [1, 0, 1], [1, 1, 1]]) +
      face('A', [[500, 500, 500], [501, 500, 500], [501, 501, 500]]));
  const cut = full.lastIndexOf('501');
  writeFileSync(path.join(dir, 'truncated.dxf'), full.slice(0, cut + 2));
}

// 6. Blocks: nested INSERT with scale, rotation, layer 0 and BYBLOCK inheritance.
{
  const blocks = section('BLOCKS',
    pairs([[0, 'BLOCK'], [8, '0'], [2, 'MARK'], [70, 0], [10, 1], [20, 0], [30, 0]]) +
    pairs([[0, 'LINE'], [8, '0'], [62, 0], [10, 1], [20, 0], [30, 0], [11, 2], [21, 0], [31, 0]]) +
    pairs([[0, 'POINT'], [8, 'FIXED'], [62, 3], [10, 1], [20, 0], [30, 0]]) +
    pairs([[0, 'ENDBLK'], [8, '0']]) +
    pairs([[0, 'BLOCK'], [8, '0'], [2, 'OUTER'], [70, 0], [10, 0], [20, 0], [30, 0]]) +
    pairs([[0, 'INSERT'], [8, '0'], [62, 0], [2, 'mark'], [10, 10], [20, 0], [30, 0], [41, 2], [42, 2], [43, 2]]) +
    pairs([[0, 'ENDBLK'], [8, '0']]));
  const ents = section('ENTITIES',
    pairs([[0, 'INSERT'], [8, 'COLLARS'], [62, 1], [2, 'OUTER'], [10, 1000], [20, 2000], [30, 300], [50, 90]]) +
    pairs([[0, 'INSERT'], [8, 'COLLARS'], [2, 'MISSING'], [10, 0], [20, 0], [30, 0]]));
  writeFileSync(path.join(dir, 'blocks.dxf'), header('AC1015') + blocks + ents + eof);
}

// 7. Binary DXF sentinel.
writeFileSync(path.join(dir, 'binary.dxf'), Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n\x1a\0', 'latin1'), Buffer.alloc(64)]));

// 8. OBJ with large coordinates, quads, negative indices and a polyline.
writeFileSync(path.join(dir, 'model.obj'), [
  '# test', 'o Pit shell',
  'v 6543210.125 17654321.5 100.25', 'v 6543211.125 17654321.5 100.25', 'v 6543211.125 17654322.5 100.25', 'v 6543210.125 17654322.5 101',
  'vn 0 0 1', 'f 1//1 2//1 3//1 4//1', 'g Strings', 'l 1 2 -1', 'f 1 2 99', '',
].join('\n'));

// 9. STL, ASCII and binary.
writeFileSync(path.join(dir, 'ascii.stl'), [
  'solid stope', ' facet normal 0 0 1', '  outer loop', '   vertex 654321.5 7654321.25 10', '   vertex 654322.5 7654321.25 10', '   vertex 654322.5 7654322.25 10.5',
  '  endloop', ' endfacet', 'endsolid stope', '',
].join('\n'));
{
  const b = Buffer.alloc(84 + 50 * 2);
  b.write('solid looks like ascii but is binary', 0, 'latin1');
  b.writeUInt32LE(2, 80);
  const tris = [[0, 0, 0, 1, 0, 0, 1, 1, 0], [0, 0, 5, 1, 0, 5, 1, 1, 5]];
  tris.forEach((t, i) => t.forEach((v, k) => b.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  writeFileSync(path.join(dir, 'binary.stl'), b);
}

// 10. GLB: one translated node, indexed triangle, Y-up.
{
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]);
  const idx = new Uint16Array([0, 1, 2, 0]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Decline', mesh: 0, translation: [100, 50, -200] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0, 1] } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  writeFileSync(path.join(dir, 'model.glb'), Buffer.concat([head, jh, j, bh, bin]));
}
console.log('fixtures written to', dir);
