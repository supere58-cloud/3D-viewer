/**
 * Builds a small synthetic mine as DXF text for the built-in tutorial: an
 * open pit, an ore body, drillholes with labels, contours. Generated in code
 * so the app ships no data file and never has to fetch one. Not real data.
 */
export function demoDxf(names: { pit: string; ore: string; holes: string; contours: string; labels: string; hole: string }): string {
  const E0 = 654000, N0 = 7654000;
  const out: string[] = [];
  const p = (code: number, value: string | number): void => { out.push(String(code), String(value)); };
  const f = (n: number): string => n.toFixed(2);

  p(0, 'SECTION'); p(2, 'HEADER'); p(9, '$ACADVER'); p(1, 'AC1027'); p(0, 'ENDSEC');
  p(0, 'SECTION'); p(2, 'TABLES'); p(0, 'TABLE'); p(2, 'LAYER');
  const layers: [string, number][] = [[names.pit, 34], [names.ore, 1], [names.holes, 4], [names.contours, 3], [names.labels, 2]];
  for (const [name, color] of layers) { p(0, 'LAYER'); p(2, name); p(70, 0); p(62, color); }
  p(0, 'ENDTAB'); p(0, 'ENDSEC');
  p(0, 'SECTION'); p(2, 'ENTITIES');

  // Pit shell with benches.
  const G = 30, size = 800;
  const height = (x: number, y: number): number => {
    const r = Math.hypot(x - size / 2, (y - size / 2) * 1.25);
    const depth = Math.max(0, 300 - r);
    return 420 - Math.floor(depth / 30) * 27 - (depth % 30) * 0.1 + Math.sin(x * 0.02) * 4 + Math.cos(y * 0.017) * 4;
  };
  for (let i = 0; i < G; i++) {
    for (let j = 0; j < G; j++) {
      const x0 = (i * size) / G, x1 = ((i + 1) * size) / G, y0 = (j * size) / G, y1 = ((j + 1) * size) / G;
      const q = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      p(0, '3DFACE'); p(8, names.pit);
      q.forEach(([x, y], k) => { p(10 + k, f(E0 + x)); p(20 + k, f(N0 + y)); p(30 + k, f(height(x, y))); });
    }
  }

  // Ore body: a tilted ellipsoid as a polyface mesh.
  const U = 16, V = 10;
  p(0, 'POLYLINE'); p(8, names.ore); p(66, 1); p(10, 0); p(20, 0); p(30, 0); p(70, 64);
  for (let v = 0; v <= V; v++) {
    for (let u = 0; u < U; u++) {
      const a = (u / U) * Math.PI * 2, b = (v / V) * Math.PI - Math.PI / 2;
      const x = Math.cos(b) * Math.cos(a) * 140, y = Math.cos(b) * Math.sin(a) * 60, z = Math.sin(b) * 45;
      p(0, 'VERTEX'); p(8, names.ore); p(10, f(E0 + 400 + x * 0.9 - z * 0.4)); p(20, f(N0 + 400 + y)); p(30, f(110 + z + x * 0.35)); p(70, 192);
    }
  }
  for (let v = 0; v < V; v++) {
    for (let u = 0; u < U; u++) {
      const a = v * U + u + 1, b = v * U + ((u + 1) % U) + 1;
      p(0, 'VERTEX'); p(8, names.ore); p(10, 0); p(20, 0); p(30, 0); p(70, 128); p(71, a); p(72, b); p(73, b + U); p(74, a + U);
    }
  }
  p(0, 'SEQEND');

  // Drillholes with collar labels.
  let hole = 100;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 3; j++) {
      hole++;
      const x = 220 + i * 90, y = 280 + j * 120, z = height(x, y);
      const az = ((250 + i * 9) * Math.PI) / 180, dip = ((60 + j * 5) * Math.PI) / 180, len = 260 + i * 15;
      p(0, 'POLYLINE'); p(8, names.holes); p(66, 1); p(10, 0); p(20, 0); p(30, 0); p(70, 8);
      for (let k = 0; k <= 6; k++) {
        const d = (len * k) / 6, bend = k * 0.015;
        p(0, 'VERTEX'); p(8, names.holes);
        p(10, f(E0 + x + Math.sin(az + bend) * Math.cos(dip) * d)); p(20, f(N0 + y + Math.cos(az + bend) * Math.cos(dip) * d)); p(30, f(z - Math.sin(dip) * d)); p(70, 32);
      }
      p(0, 'SEQEND');
      p(0, 'TEXT'); p(8, names.labels); p(10, f(E0 + x + 3)); p(20, f(N0 + y + 3)); p(30, f(z + 2)); p(40, 10); p(1, `${names.hole}${hole}`);
    }
  }

  // Contours as LWPOLYLINE with elevation.
  for (let k = 0; k < 6; k++) {
    const r = 120 + k * 36, z = 180 + k * 30;
    p(0, 'LWPOLYLINE'); p(8, names.contours); p(90, 40); p(70, 1); p(38, z);
    for (let a = 0; a < 40; a++) { p(10, f(E0 + 400 + Math.cos((a / 40) * Math.PI * 2) * r)); p(20, f(N0 + 400 + (Math.sin((a / 40) * Math.PI * 2) * r) / 1.25)); }
  }
  p(0, 'ENDSEC'); p(0, 'EOF');
  return out.join('\n') + '\n';
}
