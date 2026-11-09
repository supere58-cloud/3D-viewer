/**
 * Z-up orbit camera driven by heading / tilt / distance, so that the plan
 * view (looking straight down, north up) has no gimbal problem.
 *
 * heading: compass bearing the camera looks towards, radians, 0 = north, clockwise.
 * tilt:    angle below the horizon, radians; PI/2 = straight down, 0 = horizontal.
 */
import { Matrix4, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';

export const FOV = 45;
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
const MIN_TILT = -Math.PI / 2 + 0.001;
const MAX_TILT = Math.PI / 2;

export interface CameraState {
  target: Vector3;
  heading: number;
  tilt: number;
  /** Distance from the target; also defines the orthographic zoom. */
  distance: number;
}

export class CameraRig {
  readonly perspective = new PerspectiveCamera(FOV, 1, 0.1, 1000);
  readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  ortho = false;
  state: CameraState = { target: new Vector3(), heading: 0.6, tilt: 0.6, distance: 100 };
  readonly right = new Vector3();
  readonly up = new Vector3();
  readonly forward = new Vector3();
  width = 1;
  height = 1;
  /** Centre and radius of everything loaded, used for clip planes. */
  sceneCenter = new Vector3();
  sceneRadius = 100;

  private basis = new Matrix4();
  private back = new Vector3();
  private anim: { from: CameraState; to: CameraState; t0: number; ms: number } | null = null;

  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.ortho ? this.orthographic : this.perspective;
  }

  /** World units per CSS pixel at the target depth. */
  get unitsPerPixel(): number {
    return (2 * this.state.distance * TAN_HALF_FOV) / this.height;
  }

  /** Height of the view at the target depth, in world units. */
  get viewSpan(): number {
    return 2 * this.state.distance * TAN_HALF_FOV;
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  animateTo(to: Partial<CameraState>, ms = 280): void {
    const from = this.clone(this.state);
    const dest = this.clone(this.state);
    if (to.target) dest.target.copy(to.target);
    if (to.heading !== undefined) {
      // Take the short way round.
      let d = (to.heading - from.heading) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      dest.heading = from.heading + d;
    }
    if (to.tilt !== undefined) dest.tilt = to.tilt;
    if (to.distance !== undefined) dest.distance = to.distance;
    this.anim = { from, to: dest, t0: performance.now(), ms };
  }

  stopAnimation(): void {
    this.anim = null;
  }

  private clone(s: CameraState): CameraState {
    return { target: s.target.clone(), heading: s.heading, tilt: s.tilt, distance: s.distance };
  }

  /** Advances any animation and writes the state into the active camera. */
  update(now: number): void {
    if (this.anim) {
      const a = this.anim;
      let k = Math.min(1, (now - a.t0) / a.ms);
      const done = k >= 1;
      k = 1 - Math.pow(1 - k, 3);
      this.state.target.lerpVectors(a.from.target, a.to.target, k);
      this.state.heading = a.from.heading + (a.to.heading - a.from.heading) * k;
      this.state.tilt = a.from.tilt + (a.to.tilt - a.from.tilt) * k;
      // Distance is interpolated geometrically so zooming feels even.
      this.state.distance = a.from.distance * Math.pow(a.to.distance / a.from.distance, k);
      if (done) this.anim = null;
    }
    const s = this.state;
    s.tilt = Math.min(MAX_TILT, Math.max(MIN_TILT, s.tilt));
    s.distance = Math.min(1e8, Math.max(1e-3, s.distance));
    const sh = Math.sin(s.heading), ch = Math.cos(s.heading);
    const st = Math.sin(s.tilt), ct = Math.cos(s.tilt);
    this.forward.set(sh * ct, ch * ct, -st);
    this.right.set(ch, -sh, 0);
    this.up.set(sh * st, ch * st, ct);
    this.back.copy(this.forward).negate();
    this.basis.makeBasis(this.right, this.up, this.back);

    const cam = this.camera;
    cam.quaternion.setFromRotationMatrix(this.basis);
    cam.position.copy(s.target).addScaledVector(this.forward, -s.distance);
    const reach = s.target.distanceTo(this.sceneCenter) + this.sceneRadius;
    const aspect = this.width / this.height;
    if (this.ortho) {
      const halfH = s.distance * TAN_HALF_FOV;
      const o = this.orthographic;
      o.left = -halfH * aspect; o.right = halfH * aspect; o.top = halfH; o.bottom = -halfH;
      // The eye sits `distance` behind the target; cover the whole scene either side.
      const depth = reach + s.distance + 1;
      o.near = -depth; o.far = depth + s.distance;
      o.updateProjectionMatrix();
    } else {
      const p = this.perspective;
      p.aspect = aspect;
      const far = (s.distance + reach) * 1.5 + 1;
      p.near = Math.max(s.distance * 0.02, far * 1e-6, 1e-3);
      p.far = far;
      p.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
  }

  orbit(dxPx: number, dyPx: number): void {
    const k = Math.PI / Math.min(this.width, this.height);
    this.state.heading += dxPx * k;
    this.state.tilt += dyPx * k;
  }

  pan(dxPx: number, dyPx: number): void {
    const u = this.unitsPerPixel;
    this.state.target.addScaledVector(this.right, -dxPx * u).addScaledVector(this.up, dyPx * u);
  }

  /** Zooms by `factor` (>1 = closer) keeping the point under (px,py) fixed. */
  zoomAt(factor: number, px: number, py: number): void {
    const s = this.state;
    const next = Math.min(1e8, Math.max(1e-3, s.distance / factor));
    const real = s.distance / next;
    const u = this.unitsPerPixel;
    const cx = px - this.width / 2, cy = py - this.height / 2;
    const k = u * (1 - 1 / real);
    s.target.addScaledVector(this.right, cx * k).addScaledVector(this.up, -cy * k);
    s.distance = next;
  }

  /** Distance at which a sphere of `radius` fills the view. */
  fitDistance(radius: number): number {
    const aspect = this.width / this.height;
    const tanH = TAN_HALF_FOV * Math.min(1, aspect);
    return Math.max(1e-2, (radius / tanH) * 1.05);
  }
}

export type GestureSink = {
  onChange(): void;
  onTap(x: number, y: number, touch: boolean): void;
  onInteract(active: boolean): void;
};

/** Touch: one finger orbits, two fingers pinch-zoom and pan. Mouse: left orbit, right/middle pan, wheel zoom. */
export class Gestures {
  private pointers = new Map<number, { x: number; y: number }>();
  private moved = false;
  private multi = false;
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private lastDist = 0;
  private lastCx = 0;
  private lastCy = 0;
  private button = 0;
  private wheelTimer = 0;

  constructor(private el: HTMLElement, private rig: CameraRig, private sink: GestureSink) {
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.upEv);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down = (e: PointerEvent): void => {
    this.el.setPointerCapture?.(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.rig.stopAnimation();
    if (this.pointers.size === 1) {
      this.moved = false;
      this.multi = false;
      this.downX = p.x; this.downY = p.y; this.downT = performance.now();
      this.button = e.pointerType === 'mouse' ? e.button : 0;
      if (e.pointerType === 'mouse' && e.shiftKey) this.button = 2;
    } else {
      this.multi = true;
      this.resetPinch();
    }
    this.sink.onInteract(true);
  };

  private resetPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    this.lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    this.lastCx = (pts[0].x + pts[1].x) / 2;
    this.lastCy = (pts[0].y + pts[1].y) / 2;
  }

  private move = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    const dx = p.x - prev.x, dy = p.y - prev.y;
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      if (!this.moved) {
        const slop = e.pointerType === 'mouse' ? 3 : 8;
        if (Math.hypot(p.x - this.downX, p.y - this.downY) < slop) return;
        this.moved = true;
      }
      if (this.multi) return; // a finger was lifted after a pinch; wait for a fresh touch
      if (this.button === 0) this.rig.orbit(dx, dy);
      else this.rig.pan(dx, dy);
      this.sink.onChange();
    } else if (this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      this.rig.pan(cx - this.lastCx, cy - this.lastCy);
      if (this.lastDist > 4 && dist > 4) this.rig.zoomAt(dist / this.lastDist, cx, cy);
      this.lastDist = dist; this.lastCx = cx; this.lastCy = cy;
      this.moved = true;
      this.sink.onChange();
    }
  };

  private upEv = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      const quick = performance.now() - this.downT < 700;
      if (!this.moved && !this.multi && quick && this.button === 0) this.sink.onTap(p.x, p.y, e.pointerType !== 'mouse');
      this.sink.onInteract(false);
    } else {
      this.resetPinch();
    }
  };

  private cancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.sink.onInteract(false);
    else this.resetPinch();
  };

  private wheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    this.rig.stopAnimation();
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    this.rig.zoomAt(Math.exp(-delta * 0.0015), p.x, p.y);
    this.sink.onInteract(true);
    this.sink.onChange();
    window.clearTimeout(this.wheelTimer);
    this.wheelTimer = window.setTimeout(() => this.sink.onInteract(false), 200);
  };
}
