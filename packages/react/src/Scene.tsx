import { applyCameraView, DragPull, readCameraView, sceneView, SteelWorld, type CameraView, type LoadBreakdown } from '@steel-webgpu/three';
import { flushSync, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { LoadedScene, SimOptions, Vec3 } from 'steel-webgpu';
import { PerspectiveCamera, type WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildScene, useBuildRegistry } from './build';
import { BuildContext, WorldContext } from './context';

// Keeps the camera above the floor.
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.03;

/** The load breakdown plus the total time to the first drawn frame. */
export interface SceneLoadTimes extends LoadBreakdown {
  totalMs: number;
  /** From the world being ready to the frame after its first step. */
  firstFrameMs: number;
}

export interface SceneHandle {
  readonly world: SteelWorld | null;
  reset(): void;
  /** Where the camera is now and what it looks at; null until the scene has loaded. */
  getCamera(): CameraView | null;
}

export interface SceneProps {
  /** A scene folder URL (holding scene.json and scene.bin) or a loaded scene. Omit it to build from children. */
  src?: string | LoadedScene;
  /** Solver options; changing them rebuilds the Sim in place without reloading the scene. */
  options?: SimOptions;
  /** Declarative scenes: gravity and frame rate. */
  gravity?: Vec3;
  fps?: number;
  paused?: boolean;
  /** Holds the simulation without pausing it, e.g. while an overlay covers the canvas. */
  suspended?: boolean;
  /** Draws the convex hulls the solver collides, one flat tint per body, instead of the scene's visuals. */
  collision?: boolean;
  /** Orbit controls around the scene's camera target. */
  controls?: boolean;
  /** Dragging loose bodies with the mouse. */
  pickable?: boolean;
  /** The viewpoint to show the scene from instead of its own, in its world frame (Z up, meters, `fov` in degrees). */
  camera?: CameraView;
  /** Moves the camera to `camera`, else the scene's viewpoint, on load and whenever `camera` changes. */
  frameCamera?: boolean;
  onLoaded?: (times: SceneLoadTimes) => void;
  onError?: (error: unknown) => void;
  ref?: Ref<SceneHandle>;
  children?: ReactNode;
}

interface PendingLoad {
  start: number;
  readyAt: number;
  times: LoadBreakdown;
}

/** One simulated scene inside <Physics>. Changing `src` swaps the Sim and scene graph; the renderer stays. */
export function Scene({
  src,
  options,
  gravity,
  fps,
  paused = false,
  suspended = false,
  collision = false,
  controls = true,
  pickable = true,
  camera: view,
  frameCamera = true,
  onLoaded,
  onError,
  ref,
  children,
}: SceneProps) {
  const gl = useThree((s) => s.gl) as unknown as WebGPURenderer;
  const camera = useThree((s) => s.camera);
  const advance = useThree((s) => s.advance);
  const [world, setWorld] = useState<SteelWorld | null>(null);
  const { registry, version } = useBuildRegistry();
  // A ref, not an effect event: it is called from useFrame, and effect events may only be called from effects.
  const latestOnLoaded = useRef(onLoaded);
  useLayoutEffect(() => {
    latestOnLoaded.current = onLoaded;
  });
  const reportError = useEffectEvent((error: unknown) => (onError ?? console.error)(error));
  const stage = useThree((s) => s.scene);
  const loadInputs = useEffectEvent(() => ({ options: options ?? {}, declarative: { gravity, fps }, precompile: { scene: stage, camera } }));
  const optionsKey = JSON.stringify(options ?? {});
  const builtWith = useRef(optionsKey);
  const pendingLoad = useRef<PendingLoad | null>(null);
  const orbit = useRef<OrbitControls | null>(null);
  const declarativeKey = JSON.stringify([gravity ?? null, fps ?? null]);
  const viewKey = JSON.stringify(view ?? null);
  const viewTarget = useRef<CameraView['target'] | null>(null);
  const latestView = useEffectEvent(() => view);

  useEffect(() => {
    if (!registry.isSettled(version)) return;
    const abort = new AbortController();
    const owned: { world?: SteelWorld } = {};
    const start = performance.now();
    const { options: simOptions, declarative, precompile } = loadInputs();
    const source = src ?? buildScene(registry.ops(), declarative);
    // Started a microtask later, so a load cancelled right away (StrictMode remounting, a quick src change) never runs.
    Promise.resolve(source)
      .then((scene) =>
        abort.signal.aborted
          ? null
          : SteelWorld.load(gl, scene, {
              sim: simOptions,
              precompile,
              onLoaded: (times) => (pendingLoad.current = { start, readyAt: performance.now(), times }),
            }),
      )
      .then(
        (next) => {
          if (!next) return;
          if (abort.signal.aborted) return next.dispose();
          owned.world = next;
          builtWith.current = JSON.stringify(simOptions);
          // Committed and drawn at once rather than on the next frame, so the scene appears as soon as it is ready.
          flushSync(() => setWorld(next));
          advance(performance.now());
        },
        (error) => abort.signal.aborted || reportError(error),
      );
    return () => {
      abort.abort();
      pendingLoad.current = null;
      owned.world?.dispose();
      setWorld(null);
    };
  }, [gl, advance, src, registry, version, declarativeKey]);

  useEffect(() => {
    if (world && builtWith.current !== optionsKey) {
      builtWith.current = optionsKey;
      void world.rebuild(loadInputs().options);
    }
  }, [world, optionsKey]);

  useEffect(() => {
    world?.setPlayback(!paused, suspended);
  }, [world, paused, suspended]);

  useEffect(() => {
    world?.setCollisionView(collision);
  }, [world, collision]);

  useEffect(() => {
    if (!world || !(camera instanceof PerspectiveCamera)) return;
    const shown = sceneView(world.scene, latestView());
    if (frameCamera) applyCameraView(camera, shown);
    viewTarget.current = shown.target;
    if (!controls && !pickable) return;
    const orbitControls = new OrbitControls(camera);
    orbitControls.target.set(...shown.target);
    orbitControls.maxPolarAngle = MAX_POLAR_ANGLE;
    orbitControls.enabled = controls;
    orbitControls.update();
    // DragPull listens first, so a grab on a loose body stops the orbit before it starts.
    const drag = pickable ? new DragPull(gl.domElement, camera, world.graph, world, orbitControls) : null;
    orbitControls.connect(gl.domElement);
    orbit.current = orbitControls;
    return () => {
      orbit.current = null;
      drag?.dispose();
      orbitControls.dispose();
    };
  }, [world, camera, gl, controls, pickable, frameCamera, viewKey]);

  useImperativeHandle(
    ref,
    () => ({
      world,
      reset: () => world?.reset(),
      getCamera: () => {
        const target = orbit.current?.target.toArray() ?? viewTarget.current;
        if (!world || !target || !(camera instanceof PerspectiveCamera)) return null;
        return readCameraView(camera, target);
      },
    }),
    [world, camera],
  );

  useFrame(() => {
    if (!world) return;
    const stepped = world.update(performance.now());
    orbit.current?.update();
    const pending = pendingLoad.current;
    if (stepped > 0 && pending) {
      pendingLoad.current = null;
      // Reported on the frame after the first step, so it includes the first draw.
      requestAnimationFrame(() => {
        const now = performance.now();
        latestOnLoaded.current?.({ ...pending.times, totalMs: now - pending.start, firstFrameMs: now - pending.readyAt });
      });
    }
  });

  return (
    <BuildContext.Provider value={registry}>
      <WorldContext.Provider value={world}>
        {world && <primitive object={world.root} />}
        {children}
      </WorldContext.Provider>
    </BuildContext.Provider>
  );
}
