// Stress check in headless Chromium: a ~100 MB DXF and a 2-million-triangle
// binary STL. Usage: npm run build && node scripts/stress.mjs <workDir>
// The files are generated into <workDir> (about 200 MB). Software rendering
// is used, so frame times here say nothing about a phone GPU.
import { createRequire } from 'node:module';
import { preview } from 'vite';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const work = path.resolve(process.argv[2] ?? 'tests/fixtures/big');
mkdirSync(work, { recursive: true });

async function write(file, gen) {
  if (existsSync(file)) return;
  const out = createWriteStream(file);
  for (const chunk of gen()) if (!out.write(chunk)) await once(out, 'drain');
  out.end();
  await once(out, 'finish');
}
const N = 1000;
const z = (i, j) => -200 + Math.sin(i * 0.01) * 60 + Math.cos(j * 0.013) * 60;
const dxf = path.join(work, 'big.dxf');
await write(dxf, function* () {
  yield '  0\r\nSECTION\r\n  2\r\nENTITIES\r\n';
  for (let i = 0; i < 470; i++) {
    let s = '';
    for (let j = 0; j < N; j++) {
      const x = 654321 + i * 2, y = 7654321 + j * 2;
      s += `  0\r\n3DFACE\r\n  8\r\nSurface${i % 8}\r\n 10\r\n${x.toFixed(3)}\r\n 20\r\n${y.toFixed(3)}\r\n 30\r\n${z(i, j).toFixed(3)}\r\n 11\r\n${(x + 2).toFixed(3)}\r\n 21\r\n${y.toFixed(3)}\r\n 31\r\n${z(i + 1, j).toFixed(3)}\r\n 12\r\n${(x + 2).toFixed(3)}\r\n 22\r\n${(y + 2).toFixed(3)}\r\n 32\r\n${z(i + 1, j + 1).toFixed(3)}\r\n 13\r\n${(x + 2).toFixed(3)}\r\n 23\r\n${(y + 2).toFixed(3)}\r\n 33\r\n${z(i + 1, j + 1).toFixed(3)}\r\n`;
    }
    yield s;
  }
  yield '  0\r\nENDSEC\r\n  0\r\nEOF\r\n';
});
const stl = path.join(work, 'big.stl');
await write(stl, function* () {
  const head = Buffer.alloc(84);
  head.writeUInt32LE(N * N * 2, 80);
  yield head;
  for (let i = 0; i < N; i++) {
    const b = Buffer.alloc(N * 100);
    for (let j = 0; j < N; j++) {
      const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]];
      q.forEach(([a, c], k) => {
        const o = j * 100 + Math.floor(k / 3) * 50 + 12 + (k % 3) * 12;
        b.writeFloatLE(a * 2, o); b.writeFloatLE(c * 2, o + 4); b.writeFloatLE(z(a, c), o + 8);
      });
    }
    yield b;
  }
});

const server = await preview({ preview: { port: 4184, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
for (const file of [dxf, stl]) {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:4184/');
  await page.waitForSelector('.toolbar .tool');
  const t0 = Date.now();
  await page.setInputFiles('input[type=file]', [file]);
  await page.waitForFunction(() => window.__app.viewer.files.length === 1 && document.querySelector('.busy').hidden, null, { timeout: 300000 });
  const loadS = (Date.now() - t0) / 1000;
  const info = await page.evaluate(async () => {
    const v = window.__app.viewer;
    const d = v.files[0].diagnostics;
    const t = performance.now();
    v.rig.update(performance.now());
    const hit = v.pick(v.rig.width / 2, v.rig.height / 2, true);
    const pickMs = performance.now() - t;
    const bvh = v.files[0].layers.every((l) => !l.mesh || !!l.mesh.geometry.boundsTree);
    return { tris: d.triangles, mb: d.bytes / 1048576, parseS: d.parseMs / 1000, pickMs, hit: hit && hit.point.map((n) => +n.toFixed(2)), bvh, heapMb: performance.memory.usedJSHeapSize / 1048576 };
  });
  console.log(`${path.basename(file)}: ${info.mb.toFixed(0)} MB, ${info.tris.toLocaleString()} triangles; load ${loadS.toFixed(1)} s (parse ${info.parseS.toFixed(1)} s); pick ${info.pickMs.toFixed(1)} ms -> ${JSON.stringify(info.hit)}; BVH on every layer: ${info.bvh}; page JS heap ${info.heapMb.toFixed(0)} MB; errors: ${errors.length}`);
  await page.close();
}
await browser.close();
await server.close();
