/** AutoCAD Color Index (ACI) to 0xRRGGBB. Index 7 is white (dark background). */

function build(): Uint32Array {
  const t = new Uint32Array(256);
  const rgb = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
  t[0] = 0xffffff;
  t[1] = 0xff0000;
  t[2] = 0xffff00;
  t[3] = 0x00ff00;
  t[4] = 0x00ffff;
  t[5] = 0x0000ff;
  t[6] = 0xff00ff;
  t[7] = 0xffffff;
  t[8] = 0x808080;
  t[9] = 0xc0c0c0;
  const levels = [1, 0.8, 0.6, 0.5, 0.3];
  for (let i = 10; i < 250; i++) {
    const hue = (Math.floor((i - 10) / 10) * 15) / 60; // 0..6
    const d = i % 10;
    const v = levels[d >> 1];
    const sat = d % 2 === 0 ? 1 : 0.5;
    const sector = Math.floor(hue);
    const f = hue - sector;
    const p = v * (1 - sat);
    const q = v * (1 - sat * f);
    const u = v * (1 - sat * (1 - f));
    let r: number, g: number, b: number;
    switch (sector % 6) {
      case 0: r = v; g = u; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = u; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = u; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    // AutoCAD truncates (0.5 -> 127), it does not round.
    const q8 = (x: number) => Math.floor(x * 255 + 1e-6);
    t[i] = rgb(q8(r), q8(g), q8(b));
  }
  const greys = [0x33, 0x50, 0x69, 0x82, 0xbe, 0xff];
  for (let i = 0; i < 6; i++) t[250 + i] = rgb(greys[i], greys[i], greys[i]);
  return t;
}

const TABLE = build();

export function aciToRgb(index: number): number {
  const i = Math.abs(index) | 0;
  return i < 256 ? TABLE[i] : 0xffffff;
}

/** Distinct, sunlight-readable colours for layers the file gives no colour. */
export const FALLBACK_PALETTE = [
  0xffd400, 0x00e5ff, 0xff6b3d, 0x7dff5a, 0xff5ad1, 0x9db4ff, 0xffffff, 0xffa600, 0x3dffb8, 0xff3d5a, 0xc8ff00,
  0xd29bff,
];
