// Prints the diagnostics the app would show for a file, without a browser.
// Usage: node scripts/inspect.mjs <file> [more files]
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { loadFromBytes } = await server.ssrLoadModule('/src/core/load.ts');
for (const file of process.argv.slice(2)) {
  const m = loadFromBytes(path.basename(file), new Uint8Array(readFileSync(file)), 1 << 20);
  const d = m.diagnostics;
  console.log(`\n${file}`);
  console.log(JSON.stringify({ ...d, bbox: d.bbox, focus: m.focus, origin: m.origin }, null, 1));
  for (const l of m.layers) {
    console.log(`  ${l.name.padEnd(40)} #${l.color.toString(16).padStart(6, '0')}${l.hidden ? ' hidden' : ''}  tri ${(l.tri?.pos.length ?? 0) / 9}${l.tri?.col ? ' (mixed colours)' : ''}  seg ${(l.seg?.pos.length ?? 0) / 6}  pt ${(l.pt?.pos.length ?? 0) / 3}`);
  }
}
await server.close();
