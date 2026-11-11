/**
 * The 3D view: scene, camera, grid, labels, picking.
 *
 * Coordinates: every file keeps a float64 origin and float32 offsets. The
 * scene itself is relative to `sceneOrigin` (the origin of the first file), so
 * the numbers that reach the GPU are always small and there is no jitter.
 * True coordinate = sceneOrigin + scene position.
 */
import {
  AmbientLight, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Group, LineBasicMaterial,
  LineSegments, Matrix4, Mesh, MeshLambertMaterial, Points, PointsMaterial, Raycaster, Scene, Vector2, Vector3,
  WebGLRenderer, type Intersection,
} from 'three';
import { MeshBVH, acceleratedRaycast, type SerializedBVH } from 'three-mesh-bvh';
import type { Diagnostics, ParsedLabels, ParsedLayer, ParsedModel, Vec3 } from '../core/types';
import { CameraRig, Gestures } from './camera';
import { pickPoints, pickSegments, type ScreenHit } from './pick';
import { ViewCube } from './viewcube';

export type Opacity = 1 | 0.5 | 0.2;
export interface LayerSettings { v: boolean; c: number | null; o: Opacity }

export interface ViewLayer {
  name: string;
  baseColor: number;
  /** User override, or null to use the colours of the file. */
  customColor: number | null;
  opacity: Opacity;
  visible: boolean;
  mesh: Mesh<BufferGeometry, MeshLambertMaterial> | null;
  lines: LineSegments<BufferGeometry, LineBasicMaterial> | null;
  points: Points<BufferGeometry, PointsMaterial> | null;
  hasVertexColors: boolean;
  counts: { tri: number; seg: number; pt: number; txt: number };
  css: string;
}

export interface ViewFile {
  id: string;
  name: string;
  origin: Vec3;
  focus: { min: Vec3; max: Vec3 } | null;
  group: Group;
  layers: ViewLayer[];
  labels: ParsedLabels;
  diagnostics: Diagnostics;
  visible: boolean;
}

export type PickKind = 'vertex' | 'surface' | 'line';
export interface PickResult {
  /** True coordinates. */
  point: Vec3;
  kind: PickKind;
  layer: string;
  file: string;
}

export interface ViewerEvents {
  onPick(result: PickResult | null): void;
  onGridStep(step: number): void;
  onContextLost(lost: boolean): void;
}


const MIN_LABEL_PX = 9;
const MAX_LABEL_PX = 30;
const MAX_LABELS = 500;
const MAX_LABELS_MOVING = 160;
const GRID_HALF = 24;
const BACKGROUND = 0x5a5e64;
/** Grid line brightness (linear), chosen to read on the grey background without competing with the model. */
const GRID_MINOR = 0.26;
const GRID_MAJOR = 0.48;

const SRGB_TO_LINEAR = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = Math.round((c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)) * 255);
  }
  return t;
})();

function cssColor(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export class Viewer {
  readonly rig = new CameraRig();
  readonly files: ViewFile[] = [];
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  readonly cube: ViewCube | null;
  private headlight = new DirectionalLight(0xffffff, 3.0);
  private raycaster = new Raycaster();
  private sceneOrigin: Vec3 | null = null;
  private grid: LineSegments<BufferGeometry, LineBasicMaterial>;
  private gridKey = '';
  private gridStep = 0;
  private gridZ = 0;
  gridEnabled = true;
  labelsEnabled = true;
  private markerA: Vec3 | null = null;
  private markerB: Vec3 | null = null;
  private pins: { p: Vec3; label: string }[] = [];
  private frame = 0;
  private dirty = false;
  private paused = false;
  private contextLost = false;
  private interacting = false;
  private lowRes = false;
  private slowFrames = 0;
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private resizeObs: ResizeObserver;
  private mvp = new Matrix4();
  private viewProj = new Matrix4();
  private tmp = new Vector3();
  private labelIdx: number[] = [];
  private labelSize: number[] = [];

  constructor(private container: HTMLElement, cubeCanvas: HTMLCanvasElement | null, private events: ViewerEvents) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    container.append(this.canvas, this.overlay);
    const octx = this.overlay.getContext('2d');
    if (!octx) throw new Error('2d canvas unavailable');
    this.octx = octx;
    this.cube = cubeCanvas ? new ViewCube(cubeCanvas, this.rig, (h, t) => this.lookFrom(h, t), (dh, dt) => this.turn(dh, dt)) : null;

    const dpr = window.devicePixelRatio || 1;
    // On dense screens MSAA costs a lot of fill rate and adds little.
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: dpr <= 1.5, alpha: false, powerPreference: 'high-performance' });
    // Neutral mid-grey: dark blues and purples stay visible, and so do white, yellow and cyan.
    this.renderer.setClearColor(BACKGROUND, 1);
    this.pixelRatio = Math.min(dpr, 2);
    this.renderer.setPixelRatio(this.pixelRatio);

    this.scene.add(new AmbientLight(0xffffff, 0.5));
    this.scene.add(this.headlight, this.headlight.target);

    // The grid is built once in cell units and scaled to the current cell
    // size. Every line is cut into cell-long pieces: some mobile GPU drivers
    // drop a whole line when one of its ends is behind the eye.
    const gridGeo = new BufferGeometry();
    const segments = (GRID_HALF * 2 + 1) * (GRID_HALF * 2) * 2;
    const gridPos = new Float32Array(segments * 6);
    let go = 0;
    for (let i = -GRID_HALF; i <= GRID_HALF; i++) {
      for (let j = -GRID_HALF; j < GRID_HALF; j++) {
        gridPos[go] = i; gridPos[go + 1] = j; gridPos[go + 3] = i; gridPos[go + 4] = j + 1;
        gridPos[go + 6] = j; gridPos[go + 7] = i; gridPos[go + 9] = j + 1; gridPos[go + 10] = i;
        go += 12;
      }
    }
    gridGeo.setAttribute('position', new BufferAttribute(gridPos, 3));
    gridGeo.setAttribute('color', new BufferAttribute(new Float32Array(segments * 6), 3));
    this.grid = new LineSegments(gridGeo, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false }));
    this.grid.frustumCulled = false;
    this.grid.renderOrder = -1;
    this.grid.visible = false;
    this.scene.add(this.grid);

    this.raycaster.firstHitOnly = true;

    new Gestures(this.overlay, this.rig, {
      onChange: () => this.requestRender(),
      onTap: (x, y, touch) => this.events.onPick(this.pick(x, y, touch)),
      onInteract: (active) => this.setInteracting(active),
      onZoomStart: (x, y, touch) => this.anchorZoom(x, y, touch),
    });

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.events.onContextLost(true);
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.events.onContextLost(false);
      this.requestRender();
    });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
  }

  // --- lifecycle ---------------------------------------------------------
  pause(): void {
    this.paused = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  resume(): void {
    this.paused = false;
    this.resize();
    this.requestRender();
  }

  requestRender(): void {
    this.dirty = true;
    if (this.frame || this.paused) return;
    this.frame = requestAnimationFrame((t) => this.render(t));
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.rig.setSize(w, h);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.requestRender();
  }

  private setInteracting(active: boolean): void {
    this.interacting = active;
    const want = active && this.lowRes ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    if (want !== this.pixelRatio) {
      this.pixelRatio = want;
      this.renderer.setPixelRatio(want);
      this.renderer.setSize(this.width, this.height, false);
    }
    this.requestRender();
  }

  // --- files -------------------------------------------------------------
  addFile(id: string, name: string, model: ParsedModel, saved: Record<string, LayerSettings> | null): ViewFile {
    const first = this.files.length === 0;
    if (!this.sceneOrigin) this.sceneOrigin = [...model.origin];
    const so = this.sceneOrigin;
    const group = new Group();
    group.position.set(model.origin[0] - so[0], model.origin[1] - so[1], model.origin[2] - so[2]);
    group.updateMatrixWorld(true);
    const txt = new Uint32Array(model.layers.length);
    for (let i = 0; i < model.labels.layer.length; i++) txt[model.labels.layer[i]]++;
    const layers = model.layers.map((l, i) => this.buildLayer(l, group, txt[i], saved?.[l.name] ?? null));
    this.scene.add(group);
    const file: ViewFile = {
      id, name, origin: model.origin, focus: model.focus, group, layers,
      labels: model.labels, diagnostics: model.diagnostics, visible: true,
    };
    this.files.push(file);
    this.updateSceneBounds();
    if (first) {
      this.rig.state.heading = (30 * Math.PI) / 180;
      this.rig.state.tilt = (35 * Math.PI) / 180;
      this.fitAll(false);
    }
    this.requestRender();
    return file;
  }

  private buildLayer(l: ParsedLayer, group: Group, txt: number, saved: LayerSettings | null): ViewLayer {
    const layer: ViewLayer = {
      name: l.name,
      baseColor: l.color,
      customColor: saved?.c ?? null,
      opacity: saved?.o ?? 1,
      visible: saved ? saved.v : !l.hidden,
      mesh: null, lines: null, points: null,
      hasVertexColors: false,
      counts: { tri: (l.tri?.pos.length ?? 0) / 9, seg: (l.seg?.pos.length ?? 0) / 6, pt: (l.pt?.pos.length ?? 0) / 3, txt },
      css: cssColor(l.color),
    };
    const geometry = (pos: Float32Array, col: Uint8Array | null): BufferGeometry => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      if (col) {
        for (let i = 0; i < col.length; i++) col[i] = SRGB_TO_LINEAR[col[i]];
        g.setAttribute('color', new BufferAttribute(col, 3, true));
        layer.hasVertexColors = true;
      }
      g.computeBoundingSphere();
      g.computeBoundingBox();
      return g;
    };
    if (l.tri) {
      const g = geometry(l.tri.pos, l.tri.col);
      if (l.tri.bvh) {
        try {
          const data = { version: l.tri.bvh.version, roots: l.tri.bvh.roots, index: null, indirectBuffer: l.tri.bvh.indirect } as unknown as SerializedBVH;
          g.boundsTree = MeshBVH.deserialize(data, g, { setIndex: false });
        } catch {
          g.boundsTree = undefined;
        }
      }
      const m = new MeshLambertMaterial({
        flatShading: true, side: DoubleSide, vertexColors: l.tri.col !== null,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      layer.mesh = new Mesh(g, m);
      if (g.boundsTree) layer.mesh.raycast = acceleratedRaycast;
      group.add(layer.mesh);
    }
    if (l.seg) {
      layer.lines = new LineSegments(geometry(l.seg.pos, l.seg.col), new LineBasicMaterial({ vertexColors: l.seg.col !== null }));
      group.add(layer.lines);
    }
    if (l.pt) {
      layer.points = new Points(geometry(l.pt.pos, l.pt.col), new PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: l.pt.col !== null }));
      group.add(layer.points);
    }
    this.applyLayer(layer);
    return layer;
  }

  /** Pushes visibility, colour and opacity of a layer into its materials. */
  applyLayer(layer: ViewLayer): void {
    const color = layer.customColor ?? layer.baseColor;
    layer.css = cssColor(color);
    const transparent = layer.opacity < 1;
    for (const obj of [layer.mesh, layer.lines, layer.points]) {
      if (!obj) continue;
      obj.visible = layer.visible;
      const mat = obj.material;
      const useVertex = layer.customColor === null && obj.geometry.hasAttribute('color');
      if (mat.vertexColors !== useVertex) {
        mat.vertexColors = useVertex;
        mat.needsUpdate = true;
      }
      (mat.color as Color).setHex(useVertex ? 0xffffff : color);
      if (mat.transparent !== transparent) {
        mat.transparent = transparent;
        mat.needsUpdate = true;
      }
      mat.opacity = layer.opacity;
      mat.depthWrite = !transparent;
      obj.renderOrder = transparent ? 1 : 0;
    }
    this.requestRender();
  }

  setFileVisible(file: ViewFile, visible: boolean): void {
    file.visible = visible;
    file.group.visible = visible;
    this.requestRender();
  }

  removeFile(file: ViewFile): void {
    const i = this.files.indexOf(file);
    if (i < 0) return;
    this.files.splice(i, 1);
    this.scene.remove(file.group);
    for (const l of file.layers) {
      for (const obj of [l.mesh, l.lines, l.points]) {
        if (!obj) continue;
        obj.geometry.boundsTree = undefined;
        obj.geometry.dispose();
        obj.material.dispose();
      }
    }
    if (this.files.length === 0) {
      this.sceneOrigin = null;
      this.markerA = this.markerB = null;
    }
    this.updateSceneBounds();
    this.requestRender();
  }

  get triangleCount(): number {
    let n = 0;
    for (const f of this.files) for (const l of f.layers) n += l.counts.tri;
    return n;
  }

  /** Scene-space bounding box of the loaded files (main models, no far outliers). */
  private bounds(only?: ViewFile): { min: Vector3; max: Vector3 } | null {
    const so = this.sceneOrigin;
    if (!so) return null;
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    let any = false;
    for (const f of this.files) {
      if ((only && f !== only) || !f.focus) continue;
      any = true;
      min.min(this.tmp.set(f.focus.min[0] - so[0], f.focus.min[1] - so[1], f.focus.min[2] - so[2]));
      max.max(this.tmp.set(f.focus.max[0] - so[0], f.focus.max[1] - so[1], f.focus.max[2] - so[2]));
    }
    return any ? { min, max } : null;
  }

  private updateSceneBounds(): void {
    const b = this.bounds();
    if (!b) {
      this.rig.sceneCenter.set(0, 0, 0);
      this.rig.sceneRadius = 100;
      return;
    }
    this.rig.sceneCenter.addVectors(b.min, b.max).multiplyScalar(0.5);
    this.rig.sceneRadius = Math.max(1, b.min.distanceTo(b.max) / 2);
    this.gridZ = b.min.z;
  }

  // --- camera ------------------------------------------------------------
  fitAll(animate = true, file?: ViewFile): void {
    const b = this.bounds(file);
    if (!b) return;
    const center = new Vector3().addVectors(b.min, b.max).multiplyScalar(0.5);
    const radius = Math.max(0.5, b.min.distanceTo(b.max) / 2);
    const distance = this.rig.fitDistance(radius);
    if (animate) this.rig.animateTo({ target: center, distance });
    else {
      this.rig.state.target.copy(center);
      this.rig.state.distance = distance;
    }
    this.requestRender();
  }

  /** Looks at the whole model from a given side. heading: compass bearing the camera looks towards; tilt: angle below the horizon. */
  lookFrom(heading: number, tilt: number): void {
    const b = this.bounds();
    const to: { heading: number; tilt: number; target?: Vector3; distance?: number } = { heading, tilt };
    if (b) {
      to.target = new Vector3().addVectors(b.min, b.max).multiplyScalar(0.5);
      to.distance = this.rig.fitDistance(Math.max(0.5, b.min.distanceTo(b.max) / 2));
    }
    this.rig.animateTo(to);
    this.requestRender();
  }

  /** Turns the view by a step around the current pivot, snapping to whole steps. */
  turn(dHeading: number, dTilt: number): void {
    const s = this.rig.state;
    const to: { heading?: number; tilt?: number } = {};
    if (dHeading !== 0) to.heading = Math.round((s.heading + dHeading) / Math.abs(dHeading)) * Math.abs(dHeading);
    if (dTilt !== 0) to.tilt = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, Math.round((s.tilt + dTilt) / Math.abs(dTilt)) * Math.abs(dTilt)));
    this.rig.animateTo(to);
    this.requestRender();
  }

  setOrtho(ortho: boolean): void {
    this.rig.ortho = ortho;
    this.requestRender();
  }

  /** Makes a true-coordinate point the centre of rotation. */
  centerOn(p: Vec3): void {
    const so = this.sceneOrigin;
    if (!so) return;
    this.rig.animateTo({ target: new Vector3(p[0] - so[0], p[1] - so[1], p[2] - so[2]) });
    this.requestRender();
  }

  setMarkers(a: Vec3 | null, b: Vec3 | null): void {
    this.markerA = a;
    this.markerB = b;
    this.requestRender();
  }

  /**
   * Start of a pinch or wheel zoom: put the pivot on whatever is under the
   * fingers so the zoom closes in on it and cannot run past it. One pick per
   * gesture, nothing per frame.
   */
  private anchorZoom(x: number, y: number, touch: boolean): void {
    const so = this.sceneOrigin;
    // The wider touch radius is used for the mouse too, so thin strings are easy to catch.
    void touch;
    const hit = so ? this.pick(x, y, true, false) : null;
    this.rig.zoomFree = !(hit && so && this.rig.anchorAt(this.tmp.set(hit.point[0] - so[0], hit.point[1] - so[1], hit.point[2] - so[2]).clone()));
  }

  /** Note pins: true-coordinate points with a short label, drawn over the model. */
  setPins(pins: { p: Vec3; label: string }[]): void {
    this.pins = pins;
    this.requestRender();
  }

  // --- render ------------------------------------------------------------
  private render(now: number): void {
    this.frame = 0;
    if (this.paused || this.contextLost) return;
    this.dirty = false;
    const t0 = performance.now();
    const rig = this.rig;
    rig.update(now);
    this.headlight.position.copy(rig.forward).multiplyScalar(-1).addScaledVector(rig.right, 0.35).addScaledVector(rig.up, 0.55);
    this.updateGrid();
    this.renderer.render(this.scene, rig.camera);
    this.viewProj.multiplyMatrices(rig.camera.projectionMatrix, rig.camera.matrixWorldInverse);
    this.drawOverlay();
    this.cube?.draw();
    // Drop to a lower resolution while moving if the device cannot keep up.
    if (this.interacting && !this.lowRes) {
      const ms = performance.now() - t0;
      this.slowFrames = ms > 24 ? this.slowFrames + 1 : 0;
      if (this.slowFrames > 4) {
        this.lowRes = true;
        this.setInteracting(true);
      }
    }
    if (rig.animating || this.dirty) this.requestRender();
  }

  private updateGrid(): void {
    const so = this.sceneOrigin;
    const g = this.grid;
    if (!so || !this.gridEnabled || this.files.length === 0) {
      g.visible = false;
      if (this.gridStep !== 0) { this.gridStep = 0; this.events.onGridStep(0); }
      return;
    }
    g.visible = true;
    const rig = this.rig;
    const st = rig.state;
    // The grid lies below the model, so what is on screen is the part of the
    // plane the view axis meets, not the part under the pivot. Centre it
    // there and size the cells for that distance, otherwise it slides out of
    // view when zooming in.
    let gx = st.target.x, gy = st.target.y, reach = st.distance;
    const fz = rig.forward.z;
    if (Math.abs(fz) > 0.03) {
      const t = Math.min((this.gridZ - st.target.z) / fz, st.distance * 40);
      if (t > -st.distance) {
        gx += rig.forward.x * t;
        gy += rig.forward.y * t;
        if (!rig.ortho) reach += t;
      }
    }
    const span = rig.viewSpan * (reach / st.distance) * Math.max(1, rig.width / rig.height);
    const step = niceStep(span / 8);
    // Lines sit on round true coordinates.
    const ix = Math.round((gx + so[0]) / step), iy = Math.round((gy + so[1]) / step);
    g.position.set(ix * step - so[0], iy * step - so[1], this.gridZ);
    g.scale.set(step, step, 1);
    // Every fifth line is brighter; only the colours depend on where the grid sits.
    const mx = ((ix % 5) + 5) % 5, my = ((iy % 5) + 5) % 5;
    const key = mx + ':' + my;
    if (key !== this.gridKey) {
      this.gridKey = key;
      const col = g.geometry.getAttribute('color') as BufferAttribute;
      const c = col.array as Float32Array;
      let o = 0;
      for (let i = -GRID_HALF; i <= GRID_HALF; i++) {
        const vx = (mx + i + 5 * GRID_HALF) % 5 === 0 ? GRID_MAJOR : GRID_MINOR;
        const vy = (my + i + 5 * GRID_HALF) % 5 === 0 ? GRID_MAJOR : GRID_MINOR;
        for (let j = 0; j < GRID_HALF * 2; j++) {
          for (let k = 0; k < 6; k++) { c[o + k] = vx; c[o + 6 + k] = vy; }
          o += 12;
        }
      }
      col.needsUpdate = true;
    }
    if (step !== this.gridStep) {
      this.gridStep = step;
      this.events.onGridStep(step);
    }
  }

  private project(x: number, y: number, z: number, m: ArrayLike<number>, out: { x: number; y: number; w: number }): void {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    out.w = w;
    out.x = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * this.width;
    out.y = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5 * this.height;
  }

  private drawOverlay(): void {
    const ctx = this.octx;
    const dpr = this.overlay.width / this.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.labelsEnabled) this.drawLabels(ctx);
    this.drawMarkers(ctx);
  }

  private drawLabels(ctx: CanvasRenderingContext2D): void {
    const W = this.width, H = this.height;
    // Pixels per world unit at w = 1.
    const scale = (H / 2) * this.rig.camera.projectionMatrix.elements[5];
    const limit = this.interacting || this.rig.animating ? MAX_LABELS_MOVING : MAX_LABELS;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    const pt = { x: 0, y: 0, w: 0 };
    for (const file of this.files) {
      const lab = file.labels;
      const n = lab.text.length;
      if (n === 0 || !file.visible) continue;
      const m = this.mvp.multiplyMatrices(this.viewProj, file.group.matrixWorld).elements;
      const idx = this.labelIdx, size = this.labelSize;
      idx.length = 0; size.length = 0;
      const pos = lab.pos, hgt = lab.height, lay = lab.layer;
      for (let i = 0; i < n; i++) {
        if (!file.layers[lay[i]].visible) continue;
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (w <= 0) continue;
        const px = ((hgt[i] || 1) * scale) / w;
        if (px < MIN_LABEL_PX) continue;
        const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * W;
        const sy = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5 * H;
        if (sx < -200 || sx > W + 20 || sy < -20 || sy > H + 60) continue;
        idx.push(i); size.push(px);
      }
      let order: number[] | null = null;
      if (idx.length > limit) {
        // Too many to draw: keep the ones that appear largest (closest).
        order = idx.map((_v, k) => k).sort((a, b) => size[b] - size[a]).slice(0, limit);
      }
      const count = order ? order.length : idx.length;
      let lastPx = -1;
      for (let k = 0; k < count; k++) {
        const j = order ? order[k] : k;
        const i = idx[j];
        const px = Math.min(MAX_LABEL_PX, size[j]);
        const rounded = Math.round(px);
        if (rounded !== lastPx) {
          lastPx = rounded;
          ctx.font = `600 ${rounded}px system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif`;
          ctx.lineWidth = Math.max(2.5, rounded / 5);
        }
        this.project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], m, pt);
        ctx.fillStyle = file.layers[lay[i]].css;
        const text = lab.text[i];
        if (text.indexOf('\n') < 0) {
          ctx.strokeText(text, pt.x, pt.y);
          ctx.fillText(text, pt.x, pt.y);
        } else {
          const lines = text.split('\n', 4);
          for (let r = 0; r < lines.length; r++) {
            ctx.strokeText(lines[r], pt.x, pt.y + r * rounded * 1.2);
            ctx.fillText(lines[r], pt.x, pt.y + r * rounded * 1.2);
          }
        }
      }
    }
  }

  private drawMarkers(ctx: CanvasRenderingContext2D): void {
    const so = this.sceneOrigin;
    if (!so) return;
    const m = this.viewProj.elements;
    const a = { x: 0, y: 0, w: 0 }, b = { x: 0, y: 0, w: 0 };
    if (this.pins.length > 0) {
      ctx.font = '700 12px system-ui, -apple-system, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 2;
      for (const pin of this.pins) {
        this.project(pin.p[0] - so[0], pin.p[1] - so[1], pin.p[2] - so[2], m, a);
        if (a.w <= 0 || a.x < -20 || a.x > this.width + 20 || a.y < -20 || a.y > this.height + 20) continue;
        // A small flag standing on the point.
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#ff9500';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x - 8, a.y - 14);
        ctx.arc(a.x, a.y - 22, 11, Math.PI * 0.78, Math.PI * 0.22);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#000';
        ctx.fillText(pin.label, a.x, a.y - 22);
      }
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
    if (!this.markerA) return;
    const A = this.markerA, B = this.markerB;
    this.project(A[0] - so[0], A[1] - so[1], A[2] - so[2], m, a);
    if (B) this.project(B[0] - so[0], B[1] - so[1], B[2] - so[2], m, b);
    if (B && a.w > 0 && b.w > 0) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = '#ffe600';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    const dot = (p: { x: number; y: number; w: number }, label: string): void => {
      if (p.w <= 0) return;
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffe600';
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffe600';
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.font = '700 15px system-ui, -apple-system, Roboto, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#000';
      ctx.strokeText(label, p.x + 13, p.y - 10);
      ctx.fillText(label, p.x + 13, p.y - 10);
    };
    dot(a, B ? '1' : '');
    if (B) dot(b, '2');
  }

  // --- picking -----------------------------------------------------------
  /**
   * x, y in CSS pixels relative to the viewport. Returns true coordinates.
   * With `snapToVertex` off the result is the point exactly under (x, y).
   */
  pick(x: number, y: number, touch: boolean, snapToVertex = true): PickResult | null {
    const so = this.sceneOrigin;
    if (!so) return null;
    const rig = this.rig;
    rig.update(performance.now());
    const cam = rig.camera;
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const radius = touch ? 24 : 10;
    const snap = !snapToVertex ? 0 : touch ? 20 : 10;
    const depthOf = (p: Vector3): number => this.tmp.copy(p).sub(cam.position).dot(rig.forward);

    // 1. Surfaces through the BVH.
    const meshes: Mesh[] = [];
    const owner = new Map<Mesh, { file: ViewFile; layer: ViewLayer }>();
    for (const file of this.files) {
      if (!file.visible) continue;
      for (const layer of file.layers) {
        if (layer.visible && layer.mesh) { meshes.push(layer.mesh); owner.set(layer.mesh, { file, layer }); }
      }
    }
    this.raycaster.setFromCamera(new Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2), cam);
    if (rig.ortho) this.raycaster.near = -1e9;
    else this.raycaster.near = 0;
    let surface: Intersection | null = null;
    for (const hit of this.raycaster.intersectObjects(meshes, false)) {
      if (!surface || hit.distance < surface.distance) surface = hit;
    }

    let best: PickResult | null = null;
    let bestDepth = Infinity;
    if (surface) {
      const o = owner.get(surface.object as Mesh)!;
      bestDepth = depthOf(surface.point);
      best = { point: [surface.point.x + so[0], surface.point.y + so[1], surface.point.z + so[2]], kind: 'surface', layer: o.layer.name, file: o.file.name };
      // Snap to the nearest corner of the hit triangle if it is close on screen.
      const fi = surface.faceIndex;
      if (fi !== undefined && fi !== null) {
        const pos = (o.layer.mesh!.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
        const m = this.mvp.multiplyMatrices(this.viewProj, o.file.group.matrixWorld).elements;
        const p = { x: 0, y: 0, w: 0 };
        let near = snap, at = -1;
        for (let k = 0; k < 3; k++) {
          const i = (fi * 3 + k) * 3;
          this.project(pos[i], pos[i + 1], pos[i + 2], m, p);
          const d = Math.hypot(p.x - x, p.y - y);
          if (p.w > 0 && d < near) { near = d; at = i; }
        }
        if (at >= 0) {
          best = {
            point: [o.file.origin[0] + pos[at], o.file.origin[1] + pos[at + 1], o.file.origin[2] + pos[at + 2]],
            kind: 'vertex', layer: o.layer.name, file: o.file.name,
          };
        }
      }
    }

    // 2. Lines and points in screen space; they win when not hidden behind the surface.
    const tolerance = Math.max(1e-3, rig.state.distance * 0.01);
    let bestPx = Infinity;
    const world = new Vector3();
    for (const file of this.files) {
      if (!file.visible) continue;
      const m = this.mvp.multiplyMatrices(this.viewProj, file.group.matrixWorld).elements;
      for (const layer of file.layers) {
        if (!layer.visible) continue;
        const consider = (hit: ScreenHit | null, kind: PickKind): void => {
          if (!hit || hit.px >= bestPx) return;
          world.set(hit.x, hit.y, hit.z).add(file.group.position);
          if (depthOf(world) > bestDepth + tolerance) return;
          bestPx = hit.px;
          best = {
            point: [file.origin[0] + hit.x, file.origin[1] + hit.y, file.origin[2] + hit.z],
            kind: hit.vertex ? 'vertex' : kind, layer: layer.name, file: file.name,
          };
        };
        if (layer.lines) {
          const pos = (layer.lines.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
          consider(pickSegments(pos, m, this.width, this.height, x, y, radius, snap), 'line');
        }
        if (layer.points) {
          const pos = (layer.points.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
          consider(pickPoints(pos, m, this.width, this.height, x, y, radius), 'vertex');
        }
      }
    }
    return best;
  }
}
