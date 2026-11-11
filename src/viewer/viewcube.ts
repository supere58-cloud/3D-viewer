/**
 * View cube: a small cube that turns with the camera. Tapping a face looks at
 * the model from that side; the four arrows around it turn the view in
 * quarter steps. It also shows where north is (the "N" face and the red
 * arrow on top), so it doubles as the north arrow.
 *
 * Drawn on a 2D canvas only when the 3D view is redrawn; no extra GPU work.
 */
import type { CameraRig } from './camera';

export interface CubeLabels { top: string; bottom: string; north: string; south: string; east: string; west: string }

interface Face {
  /** Outward normal. */
  n: [number, number, number];
  /** Corner indices, counter-clockwise seen from outside. */
  c: [number, number, number, number];
  label: keyof CubeLabels;
  /** Camera heading and tilt (radians) that look straight at this face. */
  heading: number;
  tilt: number;
}

const H = Math.PI / 2;
// Corners: bit 0 = +x (east), bit 1 = +y (north), bit 2 = +z (up).
const CORNERS: [number, number, number][] = [];
for (let i = 0; i < 8; i++) CORNERS.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]);
const FACES: Face[] = [
  { n: [0, 0, 1], c: [4, 5, 7, 6], label: 'top', heading: 0, tilt: H },
  { n: [0, 0, -1], c: [0, 2, 3, 1], label: 'bottom', heading: 0, tilt: -H },
  { n: [0, -1, 0], c: [0, 1, 5, 4], label: 'south', heading: 0, tilt: 0 },
  { n: [0, 1, 0], c: [3, 2, 6, 7], label: 'north', heading: Math.PI, tilt: 0 },
  { n: [1, 0, 0], c: [1, 3, 7, 5], label: 'east', heading: 3 * H, tilt: 0 },
  { n: [-1, 0, 0], c: [2, 0, 4, 6], label: 'west', heading: H, tilt: 0 },
];

export class ViewCube {
  labels: CubeLabels = { top: 'Top', bottom: 'Bottom', north: 'N', south: 'S', east: 'E', west: 'W' };
  private ctx: CanvasRenderingContext2D | null;
  /** Screen polygons of the faces drawn last, for hit testing (CSS pixels). */
  private drawn: { face: Face; pts: number[] }[] = [];
  private size = 136;

  constructor(
    private canvas: HTMLCanvasElement, private rig: CameraRig,
    private onFace: (heading: number, tilt: number) => void,
    private onTurn: (dHeading: number, dTilt: number) => void,
  ) {
    this.ctx = canvas.getContext('2d');
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      this.tap(e.clientX - r.left, e.clientY - r.top);
    });
  }

  /** Width of the arrow strip along each edge. */
  private get margin(): number {
    return this.size * 0.2;
  }

  private tap(x: number, y: number): void {
    const s = this.size, m = this.margin;
    for (const d of this.drawn) {
      if (inside(d.pts, x, y)) { this.onFace(d.face.heading, d.face.tilt); return; }
    }
    // Arrows: the camera moves the way the arrow points.
    if (x < m) this.onTurn(H, 0);
    else if (x > s - m) this.onTurn(-H, 0);
    else if (y < m) this.onTurn(0, H / 2);
    else if (y > s - m) this.onTurn(0, -H / 2);
  }

  draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const cv = this.canvas;
    const css = cv.clientWidth || 136;
    this.size = css;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (cv.width !== Math.round(css * dpr)) { cv.width = Math.round(css * dpr); cv.height = cv.width; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    const c = css / 2, m = this.margin;
    const half = (css - 2 * m) * 0.29; // half edge length on screen

    // Arrows.
    ctx.fillStyle = 'rgba(20,25,32,0.92)';
    ctx.strokeStyle = '#f4f7fa';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    const arrow = (ax: number, ay: number, dx: number, dy: number): void => {
      const w = m * 0.42, l = m * 0.34;
      ctx.beginPath();
      ctx.moveTo(ax + dx * l, ay + dy * l);
      ctx.lineTo(ax - dx * l + dy * w, ay - dy * l + dx * w);
      ctx.lineTo(ax - dx * l - dy * w, ay - dy * l - dx * w);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };
    arrow(m / 2, c, -1, 0);
    arrow(css - m / 2, c, 1, 0);
    arrow(c, m / 2, 0, -1);
    arrow(c, css - m / 2, 0, 1);

    // Cube, oriented like the camera.
    const r = this.rig.right, u = this.rig.up, f = this.rig.forward;
    const sx: number[] = [], sy: number[] = [];
    for (const p of CORNERS) {
      sx.push(c + (p[0] * r.x + p[1] * r.y + p[2] * r.z) * half);
      sy.push(c - (p[0] * u.x + p[1] * u.y + p[2] * u.z) * half);
    }
    this.drawn.length = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const face of FACES) {
      // Facing the viewer when the normal points against the view direction.
      const facing = -(face.n[0] * f.x + face.n[1] * f.y + face.n[2] * f.z);
      if (facing <= 0.02) continue;
      const pts: number[] = [];
      for (const i of face.c) pts.push(sx[i], sy[i]);
      this.drawn.push({ face, pts });
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k < 8; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
      ctx.closePath();
      const shade = Math.round(34 + 46 * facing);
      ctx.fillStyle = `rgb(${shade},${shade + 5},${shade + 12})`;
      ctx.fill();
      ctx.strokeStyle = '#f4f7fa';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (facing < 0.3) continue; // too edge-on to read
      const fx = (pts[0] + pts[2] + pts[4] + pts[6]) / 4, fy = (pts[1] + pts[3] + pts[5] + pts[7]) / 4;
      const text = this.labels[face.label];
      const px = Math.max(9, Math.min(half * 0.8, (half * 2.6) / Math.max(2, text.length)) * (0.55 + 0.45 * facing));
      ctx.font = `700 ${px.toFixed(1)}px system-ui, -apple-system, Roboto, sans-serif`;
      ctx.fillStyle = face.label === 'north' ? '#ff6b57' : '#f4f7fa';
      ctx.fillText(text, fx, fy);
      if (face.label === 'top' || face.label === 'bottom') {
        // Small north marker on the horizontal faces: a triangle at the north edge.
        const nx = r.y, ny = -u.y;
        const len = Math.hypot(nx, ny);
        if (len > 0.2) {
          const ex = fx + (nx * half * 0.78), ey = fy + (ny * half * 0.78);
          const tx = -ny / len, ty = nx / len, w = half * 0.2;
          ctx.fillStyle = '#ff6b57';
          ctx.beginPath();
          ctx.moveTo(ex + (nx / len) * w, ey + (ny / len) * w);
          ctx.lineTo(ex + tx * w, ey + ty * w);
          ctx.lineTo(ex - tx * w, ey - ty * w);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }
}

function inside(pts: number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
