import { sceneLoader, SteelWorld, type LoadBreakdown } from '@steel-webgpu/three';
import type { LoadedScene, SimOptions } from 'steel-webgpu';
import { metric } from 'steel-webgpu/device';
import type { Hud, SolverState } from './hud';
import type { SolverTuning } from './query';
import type { Stage } from './stage';

const FPS_WINDOW_MS = 500;
const STATS_INTERVAL_MS = 250;

export interface ViewerControls {
  running: boolean;
  compareOff: boolean;
  tuning: SolverTuning;
}

function simOptions(scene: LoadedScene, solver: SimOptions, { compareOff, tuning }: ViewerControls): SimOptions {
  const compare = scene.json.info.compare;
  const { substeps, iterations, sleeping, momentum } = tuning;
  return {
    ...solver,
    ...(substeps ? { substeps } : {}),
    ...(iterations ? { iterations } : {}),
    solver: {
      ...(compareOff && compare ? { [compare.option]: compare.off } : {}),
      ...(sleeping !== undefined ? { enable_sleeping: sleeping } : {}),
      ...(momentum !== undefined ? { nesterov_momentum: momentum } : {}),
    },
  };
}

const loadStages = ({ filesMs, physicsMs, geometryMs, renderCompileMs }: LoadBreakdown, firstFrameMs: number) =>
  Object.entries({ fetch: filesMs, 'physics compile': physicsMs, geometry: geometryMs, 'render compile': renderCompileMs, 'first frame': firstFrameMs })
    .map(([stage, ms]) => `${stage} ${Math.round(ms)}`)
    .join(', ');

interface PendingLoad {
  start: number;
  readyAt: number;
  times: LoadBreakdown;
}

/** Runs one scene at a time on the stage: loading, the frame loop, playback, solver rebuilds and the HUD stats. */
export class Viewer {
  private world: SteelWorld | null = null;
  private sceneName = '';
  private loads = 0;
  private pendingLoad: PendingLoad | null = null;
  private suspended = false;
  private collision = false;
  private fpsWindow = { frames: 0, start: 0, simStart: 0 };
  private statsDueAt = 0;

  constructor(
    private readonly stage: Stage,
    private readonly hud: Hud,
    private readonly assetsBase: string,
    private readonly solver: SimOptions,
    private controls: ViewerControls,
  ) {
    stage.renderer.setAnimationLoop(() => this.frame(performance.now()));
  }

  /** Replaces the running scene with `scene`; a newer call supersedes this one. */
  async open(scene: string, controls: ViewerControls) {
    const load = ++this.loads;
    this.controls = controls;
    this.pendingLoad = null;
    this.stage.clear();
    this.world?.dispose();
    this.world = null;
    this.hud.loading();
    const start = performance.now();
    const url = `${this.assetsBase}/${scene}`;
    try {
      const loaded = await sceneLoader().load(url).scene;
      if (load !== this.loads) return;
      const world = await SteelWorld.load(this.stage.renderer, url, {
        sim: simOptions(loaded, this.solver, controls),
        precompile: { scene: this.stage.scene, camera: this.stage.camera },
        onLoaded: (times) => load === this.loads && (this.pendingLoad = { start, readyAt: performance.now(), times }),
      });
      if (load !== this.loads) return world.dispose();
      this.sceneName = scene;
      this.show(world);
    } catch (error) {
      if (load !== this.loads) return;
      this.hud.showError('The scene failed to load; see the console.');
      console.error(error);
    }
  }

  setControls(controls: ViewerControls) {
    const rebuild = controls.compareOff !== this.controls.compareOff || JSON.stringify(controls.tuning) !== JSON.stringify(this.controls.tuning);
    this.controls = controls;
    this.hud.showPlaying(controls.running);
    this.applyPlayback();
    if (rebuild && this.world) void this.rebuild(this.world);
  }

  /** Holds the simulation without pausing it, e.g. while the gallery covers the canvas. */
  suspend(held: boolean) {
    this.suspended = held;
    this.applyPlayback();
  }

  reset() {
    this.world?.reset();
  }

  /** Draws the convex hulls the solver collides instead of the scene's visuals, for this and later scenes. */
  setCollision(collision: boolean) {
    this.collision = collision;
    this.world?.setCollisionView(collision);
  }

  private show(world: SteelWorld) {
    this.world = world;
    world.setCollisionView(this.collision);
    this.stage.show(world);
    this.applyPlayback();
    this.hud.showScene(this.sceneName, world.scene, this.solverState(world), this.controls.compareOff);
    this.hud.showPlaying(this.controls.running);
    this.fpsWindow = { frames: 0, start: performance.now(), simStart: 0 };
  }

  private async rebuild(world: SteelWorld) {
    await world.rebuild(simOptions(world.scene, this.solver, this.controls));
    if (world === this.world) this.hud.showSolver(this.solverState(world));
  }

  private solverState(world: SteelWorld): SolverState {
    const { substeps, iterations } = world.sim.opts;
    return { substeps, iterations, sleeping: !!world.sim.solver.enable_sleeping, momentum: !!world.sim.solver.nesterov_momentum };
  }

  private applyPlayback() {
    this.world?.setPlayback(this.controls.running, this.suspended);
  }

  private frame(now: number) {
    const world = this.world;
    if (world) {
      const stepped = world.update(now);
      if (stepped > 0) this.reportLoad();
      this.countFrame(world, now);
      if (now >= this.statsDueAt) {
        this.statsDueAt = Infinity;
        void this.sampleStats(world).finally(() => (this.statsDueAt = performance.now() + STATS_INTERVAL_MS));
      }
    }
    this.stage.draw();
  }

  /** Reported on the frame after the first step, so the load time includes the first draw. */
  private reportLoad() {
    const pending = this.pendingLoad;
    if (!pending) return;
    this.pendingLoad = null;
    requestAnimationFrame(() => {
      const now = performance.now();
      this.hud.set('load', `${Math.round(now - pending.start)} ms`, loadStages(pending.times, now - pending.readyAt));
    });
  }

  private countFrame(world: SteelWorld, now: number) {
    const counted = this.fpsWindow;
    counted.frames++;
    const elapsed = now - counted.start;
    if (elapsed <= FPS_WINDOW_MS) return;
    this.hud.set('fps', ((counted.frames * 1000) / elapsed).toFixed(0));
    this.hud.set('rtf', this.controls.running ? `${(((world.sim.time - counted.simStart) * 1000) / elapsed).toFixed(2)}x` : '-');
    this.fpsWindow = { frames: 0, start: now, simStart: world.sim.time };
  }

  private async sampleStats(world: SteelWorld) {
    const stats = await world.requestStats();
    if (world !== this.world) return;
    world.refreshPoses();
    const poses = world.poses();
    if (poses) this.hud.showMetric(metric(world.scene, poses));
    const asleep = stats.asleep ? `, ${stats.asleep} asleep` : '';
    const full = stats.overflow.length ? ' (capacity reached)' : '';
    this.hud.set('time', `${world.sim.time.toFixed(2)} s`);
    this.hud.set('contacts', `${stats.contacts}${asleep}${full}`);
    if (stats.gpuFrameMs !== undefined) this.hud.set('gpu', `${stats.gpuFrameMs.toFixed(2)} ms`);
  }
}
