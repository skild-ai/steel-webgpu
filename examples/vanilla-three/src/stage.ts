import { applyCameraView, applyStudio, createStudioRenderer, DragPull, type SteelWorld } from '@skild-ai/steel-webgpu/three';
import { PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const MAX_PIXEL_RATIO = 1.5;
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.03;

/** The renderer, the studio scene and the camera; shows one world at a time with orbit controls and drag-to-pull. */
export class Stage {
  readonly scene = applyStudio(new Scene());
  readonly camera = new PerspectiveCamera(40, 1, 0.01, 1000);
  private orbit: OrbitControls | null = null;
  private drag: DragPull | null = null;

  static async create(canvas: HTMLCanvasElement, device: GPUDevice) {
    return new Stage(await createStudioRenderer({ canvas, device }));
  }

  private constructor(readonly renderer: WebGPURenderer) {
    this.camera.up.set(0, 0, 1);
    this.fit();
    new ResizeObserver(() => this.fit()).observe(this.canvas);
    // Builds the renderer's own pipelines (sky, output pass) before the first scene arrives.
    this.renderer.render(this.scene, this.camera);
  }

  get canvas() {
    return this.renderer.domElement;
  }

  /** Shows `world` and frames the camera on its view; the owner disposes the world, which also detaches it. */
  show(world: SteelWorld) {
    this.clear();
    this.scene.add(world.root);
    applyCameraView(this.camera, world.view);
    const orbit = new OrbitControls(this.camera);
    orbit.target.set(...world.view.target);
    orbit.maxPolarAngle = MAX_POLAR_ANGLE;
    orbit.update();
    // DragPull listens first, so a grab on a body stops the orbit before it starts.
    this.drag = new DragPull(this.canvas, this.camera, world.graph, world, orbit);
    orbit.connect(this.canvas);
    this.orbit = orbit;
  }

  /** Drops the orbit and drag handlers of the shown world, e.g. before it is disposed. */
  clear() {
    this.drag?.dispose();
    this.orbit?.dispose();
    this.drag = null;
    this.orbit = null;
  }

  draw() {
    this.orbit?.update();
    this.renderer.render(this.scene, this.camera);
  }

  private fit() {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
