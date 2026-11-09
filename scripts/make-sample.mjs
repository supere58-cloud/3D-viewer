// Writes samples/demo-mine.dxf: a small synthetic open pit with an ore body,
// drillholes, contours and Cyrillic labels, encoded as Windows-1251 the way a
// Russian-language Micromine install would export it. Synthetic data only.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
mkdirSync(out, { recursive: true });
const E0 = 654000, N0 = 7654000;
let s = '';
const p = (c, v) => { s += `${String(c).padStart(3)}\r\n${v}\r\n`; };
const f = (n) => n.toFixed(3);

p(0, 'SECTION'); p(2, 'HEADER'); p(9, '$ACADVER'); p(1, 'AC1015'); p(9, '$DWGCODEPAGE'); p(3, 'ANSI_1251'); p(0, 'ENDSEC');
p(0, 'SECTION'); p(2, 'TABLES'); p(0, 'TABLE'); p(2, 'LAYER'); p(70, 6);
for (const [name, color] of [['Карьер', 34], ['Рудное тело', 1], ['Скважины', 4], ['Горизонтали', 3], ['Подписи', 2], ['Съёмка', 6]]) {
  p(0, 'LAYER'); p(2, name); p(70, 0); p(62, color); p(6, 'CONTINUOUS');
}
p(0, 'ENDTAB'); p(0, 'ENDSEC');
p(0, 'SECTION'); p(2, 'ENTITIES');

// Pit shell: a cone-like depression with benches.
const G = 44, size = 800;
const height = (x, y) => {
  const r = Math.hypot(x - size / 2, (y - size / 2) * 1.25);
  const depth = Math.max(0, 300 - r);
  return 420 - Math.floor(depth / 30) * 30 * 0.9 - (depth % 30) * 0.1 + Math.sin(x * 0.02) * 4 + Math.cos(y * 0.017) * 4;
};
for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
  const x0 = (i * size) / G, x1 = ((i + 1) * size) / G, y0 = (j * size) / G, y1 = ((j + 1) * size) / G;
  const q = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  p(0, '3DFACE'); p(8, 'Карьер');
  q.forEach(([x, y], k) => { p(10 + k, f(E0 + x)); p(20 + k, f(N0 + y)); p(30 + k, f(height(x, y))); });
}

// Ore body: tilted ellipsoid as a polyface mesh.
const U = 20, V = 12;
p(0, 'POLYLINE'); p(8, 'Рудное тело'); p(66, 1); p(10, 0); p(20, 0); p(30, 0); p(70, 64); p(71, U * (V + 1)); p(72, U * V);
for (let v = 0; v <= V; v++) for (let u = 0; u < U; u++) {
  const a = (u / U) * Math.PI * 2, b = (v / V) * Math.PI - Math.PI / 2;
  const x = Math.cos(b) * Math.cos(a) * 140, y = Math.cos(b) * Math.sin(a) * 60, z = Math.sin(b) * 45;
  p(0, 'VERTEX'); p(8, 'Рудное тело'); p(10, f(E0 + 400 + x * 0.9 - z * 0.4)); p(20, f(N0 + 400 + y)); p(30, f(110 + z + x * 0.35)); p(70, 192);
}
for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) {
  const a = v * U + u + 1, b = v * U + ((u + 1) % U) + 1;
  p(0, 'VERTEX'); p(8, 'Рудное тело'); p(10, 0); p(20, 0); p(30, 0); p(70, 128); p(71, a); p(72, b); p(73, b + U); p(74, a + U);
}
p(0, 'SEQEND');

// Drillholes: 3D polylines with a collar label and a survey point.
let hole = 100;
for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
  hole++;
  const x = 200 + i * 80, y = 250 + j * 100, z = height(x, y);
  const az = ((250 + i * 9) * Math.PI) / 180, dip = ((60 + j * 5) * Math.PI) / 180, len = 260 + i * 15;
  p(0, 'POLYLINE'); p(8, 'Скважины'); p(66, 1); p(10, 0); p(20, 0); p(30, 0); p(70, 8);
  for (let k = 0; k <= 8; k++) {
    const d = (len * k) / 8, bend = k * 0.012;
    p(0, 'VERTEX'); p(8, 'Скважины');
    p(10, f(E0 + x + Math.sin(az + bend) * Math.cos(dip) * d)); p(20, f(N0 + y + Math.cos(az + bend) * Math.cos(dip) * d)); p(30, f(z - Math.sin(dip) * d)); p(70, 32);
  }
  p(0, 'SEQEND');
  p(0, 'TEXT'); p(8, 'Подписи'); p(10, f(E0 + x + 3)); p(20, f(N0 + y + 3)); p(30, f(z + 2)); p(40, 8); p(1, `Скв. №${hole}`);
  p(0, 'POINT'); p(8, 'Съёмка'); p(10, f(E0 + x)); p(20, f(N0 + y)); p(30, f(z));
}
p(0, 'MTEXT'); p(8, 'Подписи'); p(10, f(E0 + 400)); p(20, f(N0 + 400)); p(30, 160); p(40, 14); p(1, '{\\fArial|b1;Рудное тело №1}\\PCu 1.2%%%');

// Contours around the pit as LWPOLYLINE with elevation.
for (let k = 0; k < 6; k++) {
  const r = 120 + k * 36, z = 180 + k * 30;
  p(0, 'LWPOLYLINE'); p(8, 'Горизонтали'); p(90, 48); p(70, 1); p(38, z);
  for (let a = 0; a < 48; a++) { p(10, f(E0 + 400 + Math.cos((a / 48) * Math.PI * 2) * r)); p(20, f(N0 + 400 + (Math.sin((a / 48) * Math.PI * 2) * r) / 1.25)); }
}
p(0, 'ENDSEC'); p(0, 'EOF');

const bytes = [];
for (const ch of s) {
  const c = ch.codePointAt(0);
  if (c < 128) bytes.push(c);
  else if (c >= 0x410 && c <= 0x44f) bytes.push(c - 0x410 + 0xc0);
  else if (c === 0x451) bytes.push(0xb8);
  else if (c === 0x401) bytes.push(0xa8);
  else if (c === 0x2116) bytes.push(0xb9);
  else throw new Error('unmapped ' + ch);
}
writeFileSync(path.join(out, 'demo-mine.dxf'), Buffer.from(bytes));
console.log('samples/demo-mine.dxf', (bytes.length / 1024).toFixed(0), 'kB');
