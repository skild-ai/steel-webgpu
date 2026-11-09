import { Sim, type DragState, type LoadedScene, type SimOptions, type SimStats } from '../index';
import type { Camera, Scene, WebGPUBackend, WebGPURenderer } from 'three/webgpu';
import { sceneView, type CameraView } from './cameraView';
import type { PullTarget } from './dragPull';
import { FramePacer } from './framePacer';
import { PoseBridge } from './poseBridge';
import { SceneGraph } from './sceneGraph';
import { DEFAULT_CAMERA } from './scenePreviewer';
import { sceneLoader } from './sceneLoader';

export type StepCallback = (sim: Sim) => void;

/** Where a scene's load time went, in milliseconds. Stages may overlap, so they can add up to more than the load. */
export interface LoadBreakdown {
  /** Fetching scene.json and scene.bin. */
  filesMs: number;
  /** Building the Sim and compiling its compute pipelines. */
  physicsMs: number;
  /** Building the scene graph and compiling its render pipelines: `geometryMs` plus `renderCompileMs`. */
  renderMs: number;
  /** From the files being ready to the scene graph being built, render geometry included. */
  geometryMs: number;
  renderCompileMs: number;
}

export interface SteelWorldOptions {
  sim?: SimOptions;
  /**
   * The three scene `root` will be added to and the camera drawing it. Given these, the load compiles the render
   * pipelines while the Sim compiles its own, so the first frame does not build them.
   */
  precompile?: { scene: Scene; camera: Camera };
  /** The viewpoint to show the scene from instead of its own; read back resolved as `world.view`. */
  camera?: CameraView;
  /** Called with the load breakdown once the world is ready to draw. */
  onLoaded?: (times: LoadBreakdown) => void;
}

export const sceneCamera = (scene: LoadedScene) => scene.json.info.camera ?? DEFAULT_CAMERA;

// WebGPUBackend sets `device` in init() but its typings do not declare it.
export const rendererDevice = (renderer: WebGPURenderer) => (renderer.backend as WebGPUBackend & { device: GPUDevice }).device;

/**
 * One simulated scene on a shared device and renderer: the Sim, its three.js scene graph and the GPU-to-GPU pose
 * copy that places it. Add `root` to a three scene and call `update(now)` once per rendered frame.
 */
export class SteelWorld implements PullTarget {
  readonly beforeStep = new Set<StepCallback>();
  readonly afterStep = new Set<StepCallback>();
  private running = true;
  private suspended = false;
  private current: Sim;
  private readonly pacer: FramePacer;
  private rebuilds = 0;
  private disposed = false;
  private posesDirty = true;
  private latestPoses: Float32Array | null = null;
  private poseReadPending = false;
  private poseSubscribers = 0;
  private statsRequests: ((stats: SimStats) => void)[] = [];
  private readonly readbacks = new Map<Sim, Set<Promise<unknown>>>();

  private constructor(
    private readonly renderer: WebGPURenderer,
    readonly scene: LoadedScene,
    sim: Sim,
    readonly graph: SceneGraph,
    private readonly bridge: PoseBridge,
    /** The viewpoint the scene is meant to be seen from: the load's `camera` option, else the scene's own. */
    readonly view: CameraView,
  ) {
    this.current = sim;
    // A frame period in the past, so the first update after the load steps at once instead of a frame later.
    this.pacer = new FramePacer(scene.json.fps, performance.now() - 1000 / scene.json.fps);
  }

  /**
   * Loads a scene folder URL through the page's SceneLoader (cached for the session, geometry built in a worker) or
   * takes a loaded scene. The Sim compiles its pipelines while the scene graph is built and, with `precompile`, its
   * render pipelines compile.
   */
  static async load(renderer: WebGPURenderer, source: string | LoadedScene, options: SteelWorldOptions = {}) {
    const device = rendererDevice(renderer);
    const start = performance.now();
    const assets = typeof source === 'string' ? sceneLoader().load(source) : { scene: Promise.resolve(source), geometry: Promise.resolve(undefined) };
    const scene = await assets.scene;
    const filesAt = performance.now();
    const times = { physicsMs: 0, geometryMs: 0, renderCompileMs: 0 };
    const simReady = Sim.create(device, scene, options.sim).then((sim) => {
      times.physicsMs = performance.now() - filesAt;
      return sim;
    });
    const built: { graph?: SceneGraph } = {};
    const renderReady = assets.geometry.then(async (geometry) => {
      const graph = (built.graph = new SceneGraph(scene, sceneCamera(scene).target, geometry));
      times.geometryMs = performance.now() - filesAt;
      if (!options.precompile) return graph;
      const compileAt = performance.now();
      await renderer.compileAsync(graph.root, options.precompile.camera, options.precompile.scene);
      times.renderCompileMs = performance.now() - compileAt;
      return graph;
    });
    const [sim, graph] = await Promise.allSettled([simReady, renderReady]);
    if (sim.status === 'rejected' || graph.status === 'rejected') {
      if (sim.status === 'fulfilled') sim.value.destroy();
      built.graph?.dispose();
      throw sim.status === 'rejected' ? sim.reason : (graph as PromiseRejectedResult).reason;
    }
    graph.value.initialPoses(sim.value.initial.bodyPose);
    const bridge = new PoseBridge(device, scene.json.bodies.count, sim.value.buffers.poses);
    const world = new SteelWorld(renderer, scene, sim.value, graph.value, bridge, sceneView(scene, options.camera));
    options.onLoaded?.({
      filesMs: filesAt - start,
      physicsMs: times.physicsMs,
      renderMs: times.geometryMs + times.renderCompileMs,
      geometryMs: times.geometryMs,
      renderCompileMs: times.renderCompileMs,
    });
    return world;
  }

  /** Pauses or resumes stepping; `held` holds it on top of that, e.g. while an overlay covers the view. */
  setPlayback(running: boolean, held = false) {
    this.running = running;
    this.suspended = held;
  }

  get root() {
    return this.graph.root;
  }

  get sim() {
    return this.current;
  }

  get pick() {
    return this.current.pick;
  }

  set pick(drag: DragState | null) {
    this.current.pick = drag;
  }

  /** The latest CPU pose snapshot (8 floats per body), or null before the first readback. */
  poses() {
    return this.latestPoses;
  }

  isDraggable(body: number) {
    return this.current.draggable[body] ?? false;
  }

  refreshPoses() {
    if (this.poseReadPending || this.disposed) return;
    this.poseReadPending = true;
    const sim = this.current;
    this.trackReadback(sim, sim.readPosesPooled())
      .then((poses) => {
        if (sim === this.current) this.latestPoses = poses;
      }, this.ignoreIfReleased(sim))
      .finally(() => (this.poseReadPending = false));
  }

  /** Keeps `poses()` fresh with one pooled readback per stepped frame until the returned function is called. */
  subscribePoses() {
    this.poseSubscribers++;
    let subscribed = true;
    return () => {
      if (subscribed) this.poseSubscribers--;
      subscribed = false;
    };
  }

  /** Solver stats from the next stepped frame, with its physics GPU time. */
  requestStats(): Promise<SimStats> {
    return new Promise((resolve) => this.statsRequests.push(resolve));
  }

  /** Steps the frames due at `now`, then places the scene graph from the new poses. Returns the frames stepped. */
  update(now: number) {
    if (this.disposed) return 0;
    const sim = this.current;
    const due = this.pacer.framesDue(now, this.isStepping());
    const statsWaiting = this.statsRequests.length > 0;
    for (let i = 0; i < due; i++) {
      for (const callback of this.beforeStep) callback(sim);
      sim.step(1, statsWaiting && i === due - 1);
      this.pacer.started();
      sim.device.queue.onSubmittedWorkDone().then(() => this.pacer.finished());
      for (const callback of this.afterStep) callback(sim);
    }
    if (statsWaiting && (due > 0 || !this.isStepping())) this.resolveStats(sim);
    if (due > 0 && this.poseSubscribers > 0) this.refreshPoses();
    if (due > 0 || this.posesDirty) this.posesDirty = !this.bridge.copy(this.renderPoseBuffer);
    this.graph.showDrag(sim.pick);
    return due;
  }

  reset() {
    this.current.reset();
    this.posesDirty = true;
  }

  /** Shows the convex hulls the solver collides, one flat tint per body, instead of the scene's visuals. */
  setCollisionView(on: boolean) {
    if (!this.disposed) this.graph.setCollisionView(on);
  }

  /** Replaces the Sim with one built from `options`, keeping the scene graph; a newer rebuild supersedes it. */
  async rebuild(options: SimOptions) {
    if (this.disposed) return;
    const rebuild = ++this.rebuilds;
    const next = await Sim.create(this.current.device, this.scene, options);
    if (this.disposed || rebuild !== this.rebuilds) {
      next.destroy();
      return;
    }
    const previous = this.current;
    this.current = next;
    this.release(previous);
    this.bridge.setSource(next.buffers.poses);
    this.posesDirty = true;
    this.latestPoses = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Detached first: a frame drawn before the owner drops `root` would otherwise re-upload what is freed here.
    this.graph.root.removeFromParent();
    this.graph.dispose();
    this.bridge.dispose();
    this.release(this.current);
  }

  private trackReadback<T>(sim: Sim, readback: Promise<T>) {
    const pending = this.readbacks.get(sim) ?? new Set<Promise<unknown>>();
    this.readbacks.set(sim, pending);
    const tracked = readback.finally(() => pending.delete(tracked));
    pending.add(tracked);
    return tracked;
  }

  // A readback may still submit copies from the Sim's buffers after it was released (stats reads twice), so they
  // are destroyed once its readbacks have settled.
  private release(sim: Sim) {
    const pending = [...(this.readbacks.get(sim) ?? [])];
    this.readbacks.delete(sim);
    void Promise.allSettled(pending).then(() => sim.destroy());
  }

  private isStepping() {
    return this.running && !this.suspended;
  }

  private resolveStats(sim: Sim) {
    const requests = this.statsRequests;
    this.statsRequests = [];
    // Stats of a Sim replaced by a rebuild meanwhile are stale; the requests then wait for the next ones.
    const retry = () => this.disposed || this.statsRequests.push(...requests);
    this.trackReadback(sim, sim.stats()).then((stats) => (sim === this.current ? requests.forEach((resolve) => resolve(stats)) : retry()), retry);
  }

  // three keeps an attribute's GPUBuffer in its backend; there is no public accessor for it.
  private readonly renderPoseBuffer = (): GPUBuffer | undefined =>
    (this.renderer.backend as WebGPUBackend & { get(o: object): { buffer?: GPUBuffer } }).get(this.graph.renderPoses.value).buffer;

  // Readbacks of a Sim destroyed meanwhile reject by design.
  private ignoreIfReleased(sim: Sim) {
    return (error: unknown) => {
      if (!this.disposed && sim === this.current) console.error(error);
    };
  }
}
