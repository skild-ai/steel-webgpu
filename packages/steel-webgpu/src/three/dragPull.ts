import { Plane, Raycaster, Vector2, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DragState } from '../index';
import type { SceneGraph } from './sceneGraph';

export interface PullTarget {
  /** Latest CPU pose snapshot, or null before the first readback. */
  poses(): Float32Array | null;
  /** Asks for a fresh snapshot; hover and grabs use it once it lands. */
  refreshPoses(): void;
  isDraggable(body: number): boolean;
  pick: DragState | null;
}

const WHEEL_DEPTH_PER_DELTA = 0.0005;

/**
 * Drag a body to pull it with a spring toward the cursor; scroll while dragging changes depth.
 * Construct before OrbitControls connects, so a grab disables orbiting before its pointerdown handler runs.
 */
export class DragPull {
  private readonly raycaster = new Raycaster();
  private anchor: Vector3 | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: PerspectiveCamera,
    private readonly graph: SceneGraph,
    private readonly target: PullTarget,
    private readonly controls: OrbitControls,
  ) {
    const opts = { signal: this.abort.signal };
    canvas.addEventListener('pointerdown', this.onDown, opts);
    canvas.addEventListener('pointermove', this.onMove, opts);
    canvas.addEventListener('pointerup', this.release, opts);
    canvas.addEventListener('pointercancel', this.release, opts);
    canvas.addEventListener('wheel', this.onWheel, { ...opts, passive: false, capture: true });
  }

  dispose() {
    this.abort.abort();
  }

  private ray(event: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  private hit(event: PointerEvent) {
    const poses = this.target.poses();
    if (!poses) return null;
    this.graph.setPickPoses(poses);
    this.ray(event);
    for (const hit of this.raycaster.intersectObjects(this.graph.pickBodies, true)) {
      const body: number | undefined = hit.object.userData.body;
      if (body === undefined || !this.target.isDraggable(body)) continue;
      const local = this.graph.pickBodies[body].worldToLocal(hit.point.clone()).sub(this.graph.bodyCom(body));
      return { body, point: hit.point.clone(), local: local.toArray() };
    }
    return null;
  }

  private readonly onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const hit = this.hit(e);
    if (!hit) return;
    this.controls.enabled = false;
    this.anchor = hit.point;
    this.target.pick = { body: hit.body, local: hit.local, target: hit.point.toArray() };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers have no capture target.
    }
  };

  private readonly onMove = (e: PointerEvent) => {
    if (!this.target.pick || !this.anchor) {
      this.target.refreshPoses();
      this.canvas.style.cursor = this.hit(e) ? 'grab' : '';
      return;
    }
    this.canvas.style.cursor = 'grabbing';
    const plane = new Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new Vector3()), this.anchor);
    const p = this.ray(e).intersectPlane(plane, new Vector3());
    if (p) this.target.pick.target = p.toArray();
  };

  private readonly release = () => {
    this.controls.enabled = true;
    if (!this.target.pick) return;
    this.target.pick = null;
    this.anchor = null;
    this.canvas.style.cursor = '';
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.target.pick || !this.anchor) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const dir = this.camera.position
      .clone()
      .sub(this.anchor)
      .normalize()
      .multiplyScalar(-e.deltaY * WHEEL_DEPTH_PER_DELTA);
    this.anchor.add(dir);
    const t = this.target.pick.target;
    this.target.pick.target = [t[0] + dir.x, t[1] + dir.y, t[2] + dir.z];
  };
}
