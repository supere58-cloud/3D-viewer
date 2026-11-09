// End-to-end smoke test in headless Chromium against the production build.
// Usage: npm run build && npm run e2e [outDir]
// Checks: the app starts, a DXF opens from the picker, picking returns true
// coordinates, layer controls work, no console errors, no CSP violations and
// not a single request leaves the origin.
import { createRequire } from 'node:module';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'e2e-out'));
mkdirSync(outDir, { recursive: true });

const server = await preview({ root, preview: { port: 4183, strictPort: true }, logLevel: 'error' });
const base = 'http://localhost:4183/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) problems.push(what); };

async function run(label, contextOptions, body) {
  console.log(label);
  const context = await browser.newContext({ serviceWorkers: 'block', ...contextOptions });
  const page = await context.newPage();
  const errors = [], foreign = [];
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/blocked by Playwright|example\.com/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().includes('example.com') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
  await page.goto(base);
  await page.waitForSelector('.toolbar .tool');
  await body(page);
  check(errors.length === 0, `no console errors or warnings${errors.length ? ': ' + errors.join(' | ') : ''}`);
  check(foreign.length === 0, `no requests outside the app${foreign.length ? ': ' + foreign.join(', ') : ''}`);
  await context.close();
}

const openFiles = async (page, files) => {
  await page.setInputFiles('input[type=file]', files);
  await page.waitForFunction((n) => window.__app.viewer.files.length >= n && document.querySelector('.busy').hidden, files.length, { timeout: 60000 });
  await page.waitForTimeout(500);
};
const sample = path.join(root, 'samples', 'demo-mine.dxf');
const fx = (n) => path.join(root, 'tests', 'fixtures', n);

await run('phone, portrait', { ...devices['Pixel 7'] }, async (page) => {
  await page.screenshot({ path: path.join(outDir, 'phone-empty.png') });
  check(await page.locator('.empty h1').innerText() === 'Откройте модель', 'Russian is the default language');
  const tools = await page.locator('.tool').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).every((r) => r.width >= 48 && r.height >= 48));
  check(tools, 'toolbar touch targets are at least 48 px');
  await openFiles(page, [sample]);
  await page.screenshot({ path: path.join(outDir, 'phone-model.png') });
  const info = await page.evaluate(() => {
    const f = window.__app.viewer.files[0];
    return { layers: f.layers.map((l) => l.name), enc: f.diagnostics.encoding, tris: f.diagnostics.triangles, warn: f.diagnostics.warnings };
  });
  check(info.enc === 'windows-1251' && info.layers.includes('Рудное тело'), `CP1251 layers decoded (${info.layers.join(', ')})`);
  check(info.tris > 4000, `${info.tris} triangles loaded`);

  // Tap the middle of the view: must hit the pit and report plausible true coordinates.
  const box = await page.locator('.stage').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
  await page.waitForSelector('.measure .m-xyz');
  const first = await page.evaluate(() => window.__app.pickA);
  check(first && Math.abs(first.point[0] - 654400) < 500 && Math.abs(first.point[1] - 7654400) < 500, `tap picks true coordinates ${JSON.stringify(first?.point.map((v) => +v.toFixed(2)))} on "${first?.layer}"`);
  await page.touchscreen.tap(box.x + box.width / 2 + 60, box.y + box.height * 0.4 + 50);
  await page.waitForSelector('.measure .m-grid');
  await page.screenshot({ path: path.join(outDir, 'phone-measure.png') });
  const cells = await page.locator('.measure .m-cell').count();
  check(cells === 5, 'second tap shows 3D / horizontal / vertical / azimuth / dip');

  // Surfaces are picked through the BVH and hide what lies behind them.
  const surf = await page.evaluate(() => {
    const v = window.__app.viewer, f = v.files[0];
    const saved = { ...v.rig.state, target: v.rig.state.target.clone() };
    v.rig.state.heading = 0; v.rig.state.tilt = Math.PI / 2;
    const hit = v.pick(v.rig.width / 2 + 3, v.rig.height / 2 + 3, false);
    f.layers.forEach((l) => { if (l.name !== 'Карьер') l.visible = false; });
    const only = v.pick(v.rig.width * 0.3, v.rig.height / 2, true);
    f.layers.forEach((l) => { l.visible = true; });
    Object.assign(v.rig.state, saved);
    return { hit, only, indexed: f.layers.every((l) => !l.mesh || !!l.mesh.geometry.boundsTree) };
  });
  check(surf.indexed, 'every mesh layer has a BVH');
  check(surf.only && surf.only.layer === 'Карьер' && surf.only.point[2] > 100 && surf.only.point[2] < 450, `surface pick returns a point on the pit: ${JSON.stringify(surf.only?.point.map((n) => +n.toFixed(2)))} (${surf.only?.kind})`);
  check(surf.hit && surf.hit.layer !== 'Скважины', `drillholes under the pit floor are not picked through it (got "${surf.hit?.layer}")`);

  // One-finger orbit changes heading; pinch changes distance.
  const before = await page.evaluate(() => ({ ...window.__app.viewer.rig.state, target: null }));
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.3;
  await touch('touchStart', [[cx, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx + i * 12, cy + i * 4]]);
  await touch('touchEnd', []);
  const orbit = await page.evaluate(() => ({ ...window.__app.viewer.rig.state, target: null }));
  check(Math.abs(orbit.heading - before.heading) > 0.1 && orbit.distance === before.distance, 'one finger orbits');
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 40 - i * 8, cy], [cx + 40 + i * 8, cy]]);
  await touch('touchEnd', []);
  const pinch = await page.evaluate(() => ({ ...window.__app.viewer.rig.state, target: null }));
  check(pinch.distance < orbit.distance * 0.7 && Math.abs(pinch.heading - orbit.heading) < 1e-9, 'two fingers pinch-zoom without rotating');

  // Layers sheet.
  await page.locator('.tool').last().tap();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'phone-layers.png') });
  const rows = await page.locator('.layer').count();
  check(rows === 6, `layers panel lists ${rows} layers`);
  await page.locator('.layer .opacity-btn').first().tap();
  check(await page.locator('.layer .opacity-btn').first().innerText() === '50%', 'opacity cycles to 50%');
  await page.getByRole('button', { name: 'Скрыть все' }).tap();
  check(await page.evaluate(() => window.__app.viewer.files[0].layers.every((l) => !l.visible)), 'hide all');
  await page.getByRole('button', { name: 'Показать все' }).tap();

  // Diagnostics and language switch.
  await page.getByRole('tab', { name: 'Диагностика' }).tap();
  await page.locator('.sheet-handle').tap();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'phone-diagnostics.png') });
  check((await page.locator('.diag').innerText()).includes('windows-1251'), 'diagnostics show the detected encoding');
  await page.getByRole('tab', { name: 'Настройки' }).tap();
  await page.getByRole('button', { name: 'English' }).tap();
  check(await page.getByRole('tab', { name: 'Settings' }).count() === 1, 'switches to English');
  await page.getByRole('button', { name: 'Русский' }).tap();

  // Layer settings and recents survive a reload.
  await page.reload();
  await page.waitForSelector('.toolbar .tool');
  await page.getByRole('tab', { name: 'Файлы' }).tap();
  await page.waitForTimeout(200);
  check(await page.locator('.recent').count() === 1, 'recent files list survives a reload');
  await page.locator('.recent-main').tap();
  await page.waitForFunction(() => window.__app.viewer.files.length === 1 && document.querySelector('.busy').hidden, null, { timeout: 60000 });
  check(await page.evaluate(() => window.__app.viewer.files[0].layers[0].opacity === 0.5), 'recent file reopens offline with its layer settings');
});

await run('phone, error handling', { ...devices['Pixel 7'] }, async (page) => {
  await page.setInputFiles('input[type=file]', [fx('binary.dxf')]);
  await page.waitForSelector('.toast.error');
  const msg = await page.locator('.toast.error').first().innerText();
  check(msg.includes('двоичный DXF'), `binary DXF gives a clear message: "${msg}"`);
  await page.screenshot({ path: path.join(outDir, 'phone-error.png') });
  await openFiles(page, [fx('truncated.dxf')]);
  check(await page.evaluate(() => window.__app.viewer.files[0].diagnostics.warnings.includes('truncated')), 'truncated DXF still opens, with a warning');
});

await run('tablet, landscape, several files', { ...devices['iPad (gen 7) landscape'], defaultBrowserType: 'chromium' }, async (page) => {
  await openFiles(page, [sample, fx('model.obj'), fx('ascii.stl'), fx('model.glb')]);
  check(await page.evaluate(() => window.__app.viewer.files.length === 4), 'DXF + OBJ + STL + GLB open together');
  const wide = await page.evaluate(() => document.getElementById('app').classList.contains('wide'));
  check(wide, 'tablet uses the side panel');
  await page.evaluate(() => { const v = window.__app.viewer; v.fitAll(false, v.files[0]); v.requestRender(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, 'tablet-model.png') });
  // Zoom in on a collar so the DXF text is large enough to be drawn.
  await page.evaluate(() => { const v = window.__app.viewer; const f = v.files[0]; v.centerOn([f.origin[0] + f.labels.pos[0], f.origin[1] + f.labels.pos[1], f.origin[2] + f.labels.pos[2]]); v.rig.stopAnimation(); v.rig.state.distance = 160; v.requestRender(); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, 'tablet-labels.png') });
  await page.locator('.tool').nth(2).tap();
  await page.waitForTimeout(600);
  const plan = await page.evaluate(() => { const s = window.__app.viewer.rig.state; return [s.heading, s.tilt]; });
  check(Math.abs(Math.sin(plan[0])) < 1e-6 && Math.abs(plan[1] - Math.PI / 2) < 1e-6, 'plan view looks straight down with north up');
  await page.evaluate(() => { const v = window.__app.viewer; v.fitAll(false, v.files[0]); });
  await page.locator('.tool').nth(5).tap();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, 'tablet-plan-ortho.png') });
  check(await page.evaluate(() => window.__app.viewer.rig.ortho), 'orthographic toggle');
});

await run('installed PWA, offline', { ...devices['Pixel 7'], serviceWorkers: 'allow' }, async (page) => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).length > 0 && navigator.serviceWorker.controller !== null, null, { timeout: 20000 }).catch(() => undefined);
  await page.context().setOffline(true);
  await page.reload();
  await page.waitForSelector('.toolbar .tool', { timeout: 15000 });
  check(true, 'app shell starts with the network switched off');
  await openFiles(page, [sample]);
  check(await page.evaluate(() => window.__app.viewer.files.length === 1), 'a model opens while offline (worker served from the cache)');
  const csp = await page.evaluate(() => fetch('https://example.com/').then(() => 'allowed', () => 'blocked'));
  check(csp === 'blocked', 'fetch() to the outside is refused');
  await page.context().setOffline(false);
  const csp2 = await page.evaluate(() => new Promise((res) => {
    document.addEventListener('securitypolicyviolation', (e) => res(e.violatedDirective), { once: true });
    fetch('https://example.com/').catch(() => undefined);
    setTimeout(() => res('no violation event'), 2000);
  }));
  check(String(csp2).startsWith('connect-src'), `with the network on, the CSP blocks it (${csp2})`);
});

await browser.close();
await server.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall checks passed');
process.exit(problems.length ? 1 : 0);
