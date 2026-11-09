// Parser throughput / memory check with a synthetic large DXF.
// Usage: node scripts/bench.mjs [megabytes=100]
// Runs the TypeScript sources through Vite's SSR transform, no build needed.
import { createServer } from 'vite';

const targetMb = Number(process.argv[2] ?? 100);
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { ModelLoader } = await server.ssrLoadModule('/src/core/load.ts');

const enc = new TextEncoder();
const header = enc.encode('  0\r\nSECTION\r\n  2\r\nENTITIES\r\n');
const footer = enc.encode('  0\r\nENDSEC\r\n  0\r\nEOF\r\n');
function faces(start, count) {
  let s = '';
  for (let i = start; i < start + count; i++) {
    const x = 654321 + (i % 1500) * 2.137, y = 7654321 + Math.floor(i / 1500) * 2.291, z = -200 + Math.sin(i * 0.001) * 80;
    s += `  0\r\n3DFACE\r\n  8\r\nLayer${i % 12}\r\n 10\r\n${x.toFixed(4)}\r\n 20\r\n${y.toFixed(4)}\r\n 30\r\n${z.toFixed(4)}\r\n` +
      ` 11\r\n${(x + 2).toFixed(4)}\r\n 21\r\n${y.toFixed(4)}\r\n 31\r\n${z.toFixed(4)}\r\n` +
      ` 12\r\n${(x + 2).toFixed(4)}\r\n 22\r\n${(y + 2).toFixed(4)}\r\n 32\r\n${(z + 1).toFixed(4)}\r\n` +
      ` 13\r\n${(x + 2).toFixed(4)}\r\n 23\r\n${(y + 2).toFixed(4)}\r\n 33\r\n${(z + 1).toFixed(4)}\r\n`;
  }
  return enc.encode(s);
}

const perFace = faces(0, 1000).length / 1000;
const total = Math.ceil((targetMb * 1024 * 1024) / perFace);
const size = header.length + footer.length + Math.round(total * perFace);
const loader = new ModelLoader('bench.dxf', size);
let bytes = 0, parseMs = 0;
const feed = (chunk) => { const t = performance.now(); loader.push(chunk); parseMs += performance.now() - t; bytes += chunk.length; };
feed(header);
for (let i = 0; i < total; i += 20000) feed(faces(i, Math.min(20000, total - i)));
feed(footer);
const t = performance.now();
const model = loader.finish();
parseMs += performance.now() - t;
const d = model.diagnostics;
console.log(`input       ${(bytes / 1048576).toFixed(1)} MB, ${d.triangles.toLocaleString()} triangles in ${d.layers} layers`);
console.log(`parse time  ${(parseMs / 1000).toFixed(2)} s  (${(bytes / 1048576 / (parseMs / 1000)).toFixed(0)} MB/s)`);
console.log(`heap        ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB, buffers ${(process.memoryUsage().arrayBuffers / 1048576).toFixed(0)} MB, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
console.log(`bbox        ${JSON.stringify(d.bbox)}`);
await server.close();
