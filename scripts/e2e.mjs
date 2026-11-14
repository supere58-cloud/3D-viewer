// End-to-end smoke test in headless Chromium against the production build.
// Usage: npm run build && npm run e2e [outDir]
// Checks: the app starts, a DXF opens from the picker, picking returns true
// coordinates, layer controls work, no console errors, no CSP violations and
// not a single request leaves the origin.
import { createRequire } from 'node:module';
import { preview } from 'vite';
import { mkdirSync, readFileSync } from 'node:fs';
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
  const { keepTour: _k, ...browserOptions } = contextOptions;
  const context = await browser.newContext({ serviceWorkers: 'block', ...browserOptions });
  const page = await context.newPage();
  const errors = [], foreign = [];
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/blocked by Playwright|example\.com/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().includes('example.com') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
  await page.goto(base);
  await page.waitForSelector('.toolbar .tool');
  // A fresh install offers the tutorial; most scenarios decline it.
  if (!contextOptions.keepTour) {
    await page.waitForSelector('.tour-skip');
    await page.locator('.tour-skip').click();
  }
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

  // Note tied to the measured point: appears in the Notes tab with coordinates and as a pin.
  await page.getByRole('button', { name: 'Заметка', exact: true }).tap();
  await page.waitForSelector('.note textarea');
  await page.locator('.note textarea').first().fill('Вывал кровли; закрепить');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'phone-notes.png') });
  const noted = await page.evaluate(() => ({ notes: window.__app.notes, pins: window.__app.viewer.pins.length, b: window.__app.pickB.point }));
  check(noted.notes.length === 1 && noted.pins === 1 && noted.notes[0].point[0] === noted.b[0] && noted.notes[0].text.startsWith('Вывал'), 'a note is tied to the picked point and pinned in the view');
  await page.getByRole('button', { name: 'Новая заметка' }).tap();
  check(await page.evaluate(() => window.__app.notes.length === 2 && window.__app.notes[1].point === null), 'a general note needs no point');
  await page.getByRole('tab', { name: 'Слои' }).tap();
  await page.getByRole('tab', { name: 'Слои' }).tap();
  await page.waitForTimeout(300);

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
  check(await page.evaluate(() => window.__app.notes.length === 2), 'notes survive a reload');
  check(await page.getByRole('button', { name: /Открыть прошлый набор \(1\)/ }).count() === 1, 'the start screen offers the files that were open last time');
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
  // View cube: the top arrow twice from an oblique view ends looking straight down; tapping the top face gives plan, north up.
  const cube = await page.locator('.viewcube').boundingBox();
  await page.touchscreen.tap(cube.x + cube.width / 2, cube.y + 8);
  await page.waitForTimeout(500);
  await page.touchscreen.tap(cube.x + cube.width / 2, cube.y + 8);
  await page.waitForTimeout(500);
  const down = await page.evaluate(() => window.__app.viewer.rig.state.tilt);
  check(Math.abs(down - Math.PI / 2) < 1e-6, 'view cube arrows tilt the view in steps up to straight down');
  await page.touchscreen.tap(cube.x + cube.width / 2, cube.y + cube.height / 2);
  await page.waitForTimeout(600);
  const plan = await page.evaluate(() => { const s = window.__app.viewer.rig.state; return [s.heading, s.tilt]; });
  check(Math.abs(Math.sin(plan[0])) < 1e-6 && Math.abs(plan[1] - Math.PI / 2) < 1e-6, 'plan view looks straight down with north up');
  await page.evaluate(() => { const v = window.__app.viewer; v.fitAll(false, v.files[0]); });
  await page.touchscreen.tap(cube.x + 8, cube.y + cube.height / 2);
  await page.waitForTimeout(500);
  const turned = await page.evaluate(() => { const s = window.__app.viewer.rig.state; return s.heading; });
  check(Math.abs(Math.abs(turned) - Math.PI / 2) < 1e-6, 'side arrow turns the view a quarter turn');
  await page.touchscreen.tap(cube.x + cube.width / 2, cube.y + cube.height - 8);
  await page.waitForTimeout(500);
  await page.touchscreen.tap(cube.x + cube.width / 2, cube.y + cube.height - 8);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, 'tablet-cube-side.png') });
  check(await page.evaluate(() => Math.abs(window.__app.viewer.rig.state.tilt) < 1e-6), 'two steps down give a horizontal side view');
  await page.getByRole('button', { name: 'Персп.' }).tap();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, 'tablet-plan-ortho.png') });
  check(await page.evaluate(() => window.__app.viewer.rig.ortho), 'orthographic toggle');
});

await run('desktop, wheel zoom', { viewport: { width: 1100, height: 700 } }, async (page) => {
  await openFiles(page, [sample]);
  const box = await page.locator('.stage').boundingBox();
  const state = () => page.evaluate(() => { const v = window.__app.viewer, s = v.rig.state; return { d: s.distance, r: v.rig.sceneRadius, t: s.target.toArray(), cam: v.rig.camera.position.toArray() }; });
  // Over the pit: zooming in closes on the surface under the cursor and never passes through it.
  const px = box.x + box.width * 0.5, py = box.y + box.height * 0.5;
  await page.mouse.move(px, py);
  const under = await page.evaluate(([x, y]) => { const v = window.__app.viewer; v.rig.update(performance.now()); return v.pick(x, y, false, false); }, [px - box.x, py - box.y]);
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);
  const after = await page.evaluate(([x, y]) => { const v = window.__app.viewer; v.rig.update(performance.now()); return v.pick(x, y, false, false); }, [px - box.x, py - box.y]);
  const near = await state();
  const moved = under && after ? Math.hypot(under.point[0] - after.point[0], under.point[1] - after.point[1], under.point[2] - after.point[2]) : NaN;
  check(under && after && moved < 1 && near.d < 1, `zooming in stays on the point under the cursor (moved ${moved.toFixed(3)} m, ${near.d.toFixed(3)} m away)`);
  // Over empty space: the camera keeps travelling instead of stalling in front of the pivot.
  await page.evaluate(() => window.__app.viewer.fitAll(false));
  await page.mouse.move(box.x + 160, box.y + box.height - 30);
  await page.waitForTimeout(400);
  const start = await state();
  for (let i = 0; i < 80; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);
  const end = await state();
  const travelled = Math.hypot(end.cam[0] - start.cam[0], end.cam[1] - start.cam[1], end.cam[2] - start.cam[2]);
  check(travelled > start.d * 1.1 && end.d >= end.r * 0.149, `zooming into empty space flies on past the pivot (${travelled.toFixed(0)} m travelled from ${start.d.toFixed(0)} m away)`);
});

await run('desktop, open a folder', { viewport: { width: 1100, height: 700 } }, async (page) => {
  check(await page.getByRole('button', { name: 'Папка' }).count() === 1, 'folder button is offered');
  // The fixtures folder holds supported models, one binary DXF and unrelated files.
  await page.setInputFiles('input[webkitdirectory]', path.join(root, 'tests', 'fixtures'));
  await page.waitForFunction(() => window.__app.viewer.files.length >= 10 && document.querySelector('.busy').hidden, null, { timeout: 60000 });
  const n = await page.evaluate(() => window.__app.viewer.files.length);
  check(n === 10, `every loadable file in the folder is opened (${n}), the unreadable one is reported and skipped`);
  const rows = await page.locator('.layer').count();
  const heads = await page.locator('.file-head').count();
  check(heads === 10 && rows < 12, `with many files open their layer lists start folded (${heads} files, ${rows} layer rows shown)`);
  await page.locator('.file-head .file-name').last().click();
  check(await page.locator('.layer').count() > rows, 'tapping a file name unfolds its layers');
  // Notes table export.
  await page.evaluate(() => window.__app.addNote({ point: [654321.126, 7654321.5, -12.3], kind: 'vertex', layer: 'Слой 1', file: 'a.dxf' }));
  await page.locator('.note textarea').first().fill('проверка; "кавычки"');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Таблица (CSV)' }).click()]);
  const csv = readFileSync(await download.path(), 'utf8');
  check(/^notes-\d{8}\.csv$/.test(download.suggestedFilename()) && csv.includes('1;') && csv.includes(';654321.13;7654321.50;-12.30;Слой 1;a.dxf;"проверка; ""кавычки"""'), 'notes export as a CSV table with coordinates');
  await page.screenshot({ path: path.join(outDir, 'desktop-folder.png') });
});

await run('phone, first run: tutorial', { ...devices['Pixel 7'], keepTour: true }, async (page) => {
  await page.waitForSelector('.tour');
  check(await page.locator('.tour h2').innerText() === 'Короткое обучение', 'the tutorial is offered on first run');
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForFunction(() => !document.querySelector('.tour-next')?.hasAttribute('disabled'), null, { timeout: 30000 });
    await page.waitForTimeout(450);
    const title = await page.locator('.tour h2').innerText();
    seen.push(title);
    if (title === 'Координаты и измерения') {
      check(await page.locator('.measure .m-grid').count() === 1, 'the measuring step shows a real measurement on the demo model');
      await page.screenshot({ path: path.join(outDir, 'tour-measure.png') });
    }
    if (title === 'Разрезы') {
      const st = await page.evaluate(() => ({ slice: !!window.__app.viewer.slice, bar: !document.querySelector('.slicebar').hidden }));
      check(st.slice && st.bar, 'the sections step turns a section on');
      await page.screenshot({ path: path.join(outDir, 'tour-slices.png') });
    }
    const last = (await page.locator('.tour-next').innerText()) === 'Готово';
    await page.locator('.tour-next').tap();
    if (last) break;
  }
  check(seen.length === 10, `the tutorial has ${seen.length} steps: ${seen.join(' / ')}`);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ files: window.__app.viewer.files.length, slice: !!window.__app.viewer.slice, slices: window.__app.slices.length, tutorial: window.__app.settings.tutorial, recents: JSON.parse(localStorage.getItem('mv.recents') || '[]').length }));
  check(after.files === 0 && !after.slice && after.slices === 0 && after.recents === 0, 'finishing closes the demo model and leaves nothing behind');
  check(after.tutorial === false, 'the tutorial does not come back on the next start');
  await page.reload();
  await page.waitForSelector('.toolbar .tool');
  await page.waitForTimeout(700);
  check(await page.locator('.tour').count() === 0, 'no tutorial after a reload');
  // It can be started again, and the privacy policy opens, from Settings.
  await page.locator('.tab[data-tab="settings"]').tap();
  await page.getByRole('button', { name: 'Политика конфиденциальности' }).tap();
  check((await page.locator('.privacy').innerText()).includes('не собирает'), 'privacy policy opens from Settings');
  await page.screenshot({ path: path.join(outDir, 'phone-privacy.png') });
  await page.locator('.privacy .btn').tap();
  await page.getByRole('button', { name: 'Пройти обучение' }).tap();
  check(await page.locator('.tour').count() === 1, 'the tutorial can be started again from Settings');
});

await run('desktop, sections', { viewport: { width: 1100, height: 700 } }, async (page) => {
  await openFiles(page, [sample]);
  await page.locator('.tab[data-tab="slices"]').click();
  // Horizontal section through the model centre.
  await page.getByRole('button', { name: 'Горизонтальный' }).click();
  await page.waitForTimeout(300);
  const h = await page.evaluate(() => { const a = window.__app; const s = a.slices[0]; return { kind: s.kind, z: s.point[2], t: s.thickness, on: !!a.viewer.slice }; });
  check(h.kind === 'h' && h.on && h.t > 0, `a horizontal section is added and shown (Z ${h.z.toFixed(1)}, ${h.t} m thick)`);
  await page.screenshot({ path: path.join(outDir, 'desktop-slice-h.png') });
  await page.getByRole('button', { name: 'Сдвинуть разрез вперёд' }).click();
  const moved = await page.evaluate(() => window.__app.slices[0].point[2]);
  check(Math.abs(moved - h.z - h.t) < 1e-6, 'the arrow pages the section by its thickness');
  await page.getByRole('button', { name: 'Толще' }).click();
  check(await page.evaluate(() => window.__app.slices[0].thickness) > h.t, 'the thickness can be changed');
  // Taps only reach what the section shows.
  const box = await page.locator('.stage').boundingBox();
  const picks = await page.evaluate(([w, hh]) => {
    const v = window.__app.viewer, s = window.__app.slices[0], out = [];
    for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) { const p = v.pick((w * i) / 8, (hh * j) / 8, false, false); if (p) out.push(Math.abs(p.point[2] - s.point[2]) <= s.thickness / 2 + 1e-3); }
    return out;
  }, [box.width, box.height]);
  check(picks.length > 0 && picks.every(Boolean), `taps hit only geometry inside the section (${picks.length} hits checked)`);
  // Vertical section along two picked points.
  await page.getByRole('button', { name: 'Выключить разрез' }).click();
  await page.evaluate(() => { const a = window.__app; a.onPick({ point: [654300, 7654300, 300], kind: 'vertex', layer: 'x', file: 'demo-mine.dxf' }); a.onPick({ point: [654500, 7654500, 250], kind: 'vertex', layer: 'x', file: 'demo-mine.dxf' }); });
  await page.getByRole('button', { name: 'Вертикальный' }).click();
  const v2 = await page.evaluate(() => { const s = window.__app.slices[1]; return { kind: s.kind, az: s.azimuth }; });
  check(v2.kind === 'v' && Math.abs(v2.az - 45) < 1e-6, `a vertical section follows the two picked points (azimuth ${v2.az.toFixed(1)}°)`);
  await page.getByRole('button', { name: 'Вид на разрез' }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, 'desktop-slice-v.png') });
  const face = await page.evaluate(() => { const s = window.__app.viewer.rig.state; return [s.heading, s.tilt]; });
  check(Math.abs(face[1]) < 1e-6 && Math.abs(Math.abs(Math.sin(face[0] - (135 * Math.PI) / 180)) ) < 1e-6, 'the eye button turns the view square to the section');
  // Section tool "by line": tap an existing line, get a cut along it and a square-on view.
  await page.getByRole('button', { name: 'Выключить разрез' }).click();
  await page.evaluate(() => { window.__app.clearMeasure(); window.__app.viewer.fitAll(false); });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /По линии/ }).click();
  check(await page.locator('.slice-pick').count() === 1, 'the by-line tool asks for a line');
  const spot = await page.evaluate(([w, hh]) => {
    const v = window.__app.viewer; v.rig.update(performance.now());
    for (let j = 6; j < 60; j++) for (let i = 6; i < 60; i++) {
      const x = (w * i) / 64, y = (hh * j) / 64;
      const p = v.pick(x, y, false);
      if (p && p.segment && p.layer === 'Скважины') return { x, y, seg: p.segment };
    }
    return null;
  }, [box.width, box.height]);
  await page.mouse.click(box.x + spot.x, box.y + spot.y);
  await page.waitForTimeout(700);
  const byLine = await page.evaluate(() => { const a = window.__app, s = a.slices[a.slices.length - 1], st = a.viewer.rig.state; return { n: a.slices.length, kind: s.kind, az: s.azimuth, active: a.activeSlice === s.id, pick: a.slicePick, measured: !!a.pickA, heading: st.heading, tilt: st.tilt, half: s.halfLength }; });
  const want = (((Math.atan2(spot.seg[1][0] - spot.seg[0][0], spot.seg[1][1] - spot.seg[0][1]) * 180) / Math.PI) % 180 + 180) % 180;
  check(byLine.n === 3 && byLine.kind === 'v' && byLine.active && !byLine.pick && !byLine.measured && Math.abs(byLine.az - want) < 1e-6, `tapping a line cuts along it (azimuth ${byLine.az.toFixed(1)}°)`);
  check(Math.abs(byLine.tilt) < 1e-6 && Math.abs(Math.cos(byLine.heading - (byLine.az * Math.PI) / 180)) < 1e-6, 'and the view turns perpendicular to the section');
  await page.screenshot({ path: path.join(outDir, 'desktop-slice-line.png') });
  await page.getByRole('button', { name: /По линии/ }).click();
  await page.mouse.click(box.x + box.width - 200, box.y + 30);
  await page.waitForTimeout(200);
  check(await page.evaluate(() => window.__app.slicePick && window.__app.slices.length === 3), 'a tap that misses keeps the tool waiting for a line');
  await page.getByRole('button', { name: 'Отмена' }).click();
  await page.reload();
  await page.waitForSelector('.toolbar .tool');
  check(await page.evaluate(() => window.__app.slices.length === 3), 'sections are remembered');
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
