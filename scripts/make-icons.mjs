// Renders the app icons (PNG) from an inline SVG using the locally installed
// Chromium. One-off tool: the PNGs are committed. Run: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Playwright is a tool on the build machine, not a project dependency.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#0b0e12"/>
<g transform="translate(256 256) scale(${pad}) translate(-256 -256)" fill="none" stroke-linejoin="round" stroke-linecap="round">
<path d="M256 84 420 178v176L256 448 92 354V178z" stroke="#46515f" stroke-width="14"/>
<path d="M92 178l164 94 164-94M256 272v176" stroke="#46515f" stroke-width="14"/>
<path d="M150 330l62-88 54 50 46-96 66 104" stroke="#ffd400" stroke-width="26"/>
<circle cx="312" cy="196" r="20" fill="#ffd400"/>
</g></svg>`;
const targets = [
  ['public/icons/icon-192.png', 192, 1], ['public/icons/icon-512.png', 512, 1],
  ['public/icons/icon-maskable-512.png', 512, 0.72], ['public/icons/apple-touch-icon.png', 180, 0.9],
  ['resources/icon-1024.png', 1024, 0.9], ['resources/icon-foreground-432.png', 432, 0.6],
];
const browser = await chromium.launch();
for (const [file, size, pad] of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg(pad)}`);
  const out = path.join(root, file);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, await page.screenshot({ type: 'png' }));
  await page.close();
}
await browser.close();
console.log('icons written');
