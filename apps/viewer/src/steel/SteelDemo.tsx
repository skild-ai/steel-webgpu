import { Physics, Scene, useSimStats, useWorld, type SceneHandle, type SceneLoadTimes } from '@skild-ai/steel-webgpu-react';
import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { SimOptions } from '@skild-ai/steel-webgpu';
import { metric } from '@skild-ai/steel-webgpu/device';
import { HudStore, initialHud, type HudState, type SolverState } from './hudStore';
import { checkboxStyle, styles } from './styles';

export interface SolverOverrides {
  regularization?: number;
  warmStart?: number;
}

/** The viewer's solver controls; unset fields keep the scene's own values. */
export interface SolverTuning {
  substeps?: number;
  iterations?: number;
  sleeping?: boolean;
  momentum?: boolean;
}

export interface SteelDemoProps {
  /** Scene folder name, e.g. "bolt_sweep". */
  scene: string;
  /** The HUD heading once the scene runs, e.g. "Bolt sweep"; the folder name when unset. */
  title?: string;
  /** URL of the folder holding the scene folders, without a trailing slash. */
  assetsBase: string;
  /** Start paused (?paused). */
  paused?: boolean;
  /** Solver overrides (?reg and ?warm). */
  solver?: SolverOverrides;
  /** Start with the scene's compare option switched off (?without). */
  compareOff?: boolean;
  /** Starting substeps, iterations, sleeping and momentum (?ss, ?it, ?sleep and ?nest). */
  tuning?: SolverTuning;
  /** Called when the solver controls change the tuning, e.g. to keep it in the URL. */
  onTuningChange?: (tuning: SolverTuning) => void;
  /** Draws the convex hulls the solver collides instead of the scene's visuals (?collision). */
  collision?: boolean;
  /** Called when the collision control changes, e.g. to keep it in the URL. */
  onCollisionChange?: (collision: boolean) => void;
  /** Shows a Menu button in the HUD, e.g. to open a scene gallery. */
  onMenu?: () => void;
  /** Holds the simulation, e.g. while a gallery covers it. */
  suspended?: boolean;
  /** Extra HUD content, such as a scene picker. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

interface SceneControls {
  running: boolean;
  compareOff: boolean;
  tuning: SolverTuning;
}

const FPS_WINDOW_MS = 500;
const PLAIN_TITLE = 'Steel WebGPU';
const STATS_HZ = 4;

function simOptionsFor(scene: HudState['scene'], solver: SolverOverrides, { compareOff, tuning }: SceneControls): SimOptions {
  const compare = scene?.json.info.compare;
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

const formatLoadStages = ({ filesMs, physicsMs, geometryMs, renderCompileMs, firstFrameMs }: SceneLoadTimes) =>
  [
    ['fetch', filesMs],
    ['physics compile', physicsMs],
    ['geometry', geometryMs],
    ['render compile', renderCompileMs],
    ['first frame', firstFrameMs],
  ]
    .map(([stage, ms]) => `${stage} ${Math.round(ms as number)}`)
    .join(', ');

export function SteelDemo({
  scene,
  title,
  assetsBase,
  paused = false,
  solver,
  compareOff = false,
  tuning,
  onTuningChange,
  collision = false,
  onCollisionChange,
  onMenu,
  suspended = false,
  children,
  className,
  style,
}: SteelDemoProps) {
  const [hud] = useState(() => new HudStore());
  const sceneRef = useRef<SceneHandle>(null);
  const initial = (): SceneControls => ({ running: !paused, compareOff, tuning: tuning ?? {} });
  const [controls, setControls] = useState(initial);
  const [shownScene, setShownScene] = useState(scene);
  if (shownScene !== scene) {
    setShownScene(scene);
    setControls(initial());
  }
  const loaded = useSyncExternalStore(hud.subscribe, () => hud.get().scene);
  const options = simOptionsFor(loaded, { regularization: solver?.regularization, warmStart: solver?.warmStart }, controls);
  const solverOverrides = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as SimOptions;

  const retune = (next: SolverTuning) => {
    setControls((c) => ({ ...c, tuning: next }));
    onTuningChange?.(next);
  };

  return (
    <div className={className} style={{ ...styles.root, ...style }}>
      <Physics style={styles.canvas} unsupported={(reason) => <Unsupported hud={hud} reason={reason} />}>
        <Scene
          ref={sceneRef}
          src={`${assetsBase}/${scene}`}
          options={solverOverrides}
          paused={!controls.running}
          suspended={suspended}
          collision={collision}
          onLoaded={(times) => hud.update({ loadTime: `${Math.round(times.totalMs)} ms`, loadStages: formatLoadStages(times) })}
        >
          <HudFeed hud={hud} running={controls.running} />
        </Scene>
      </Physics>
      <Hud
        hud={hud}
        title={title ?? scene}
        sceneUrl={`${assetsBase}/${scene}`}
        controls={controls}
        setCompare={(enabled) => setControls((c) => ({ ...c, compareOff: !enabled }))}
        togglePlay={() => setControls((c) => ({ ...c, running: !c.running }))}
        reset={() => sceneRef.current?.reset()}
        retune={retune}
        collision={collision}
        setCollision={(on) => onCollisionChange?.(on)}
        onMenu={onMenu}
      >
        {children}
      </Hud>
    </div>
  );
}

function Unsupported({ hud, reason }: { hud: HudStore; reason: string }) {
  useLayoutEffect(() => hud.update({ status: { kind: 'unsupported', reason } }), [hud, reason]);
  return null;
}

/** Lives inside the scene: feeds the HUD store from the world, so the HUD re-renders without the canvas tree. */
function HudFeed({ hud, running }: { hud: HudStore; running: boolean }) {
  const world = useWorld();
  const stats = useSimStats({ hz: STATS_HZ });
  const fpsWindow = useRef({ frames: 0, start: 0, simStart: 0 });

  useLayoutEffect(() => {
    if (!world) {
      hud.update({ ...initialHud, status: { kind: 'loading' }, loadTime: 'loading...' });
      return;
    }
    const { substeps, iterations } = world.sim.opts;
    // A cached scene can replace the previous world without a loading state in between, so nothing of it may remain.
    hud.update({
      ...initialHud,
      loadTime: 'loading...',
      status: { kind: 'running' },
      scene: world.scene,
      solverDefaults: {
        substeps,
        iterations,
        sleeping: !!world.sim.solver.enable_sleeping,
        momentum: !!world.sim.solver.nesterov_momentum,
      },
    });
    fpsWindow.current = { frames: 0, start: performance.now(), simStart: 0 };
  }, [world, hud]);

  useEffect(() => {
    if (!world || !stats) return;
    world.refreshPoses();
    const poses = world.poses();
    const shown = poses ? metric(world.scene, poses) : hud.get().metric;
    const asleep = stats.asleep ? `, ${stats.asleep} asleep` : '';
    const full = stats.overflow.length ? ' (capacity reached)' : '';
    hud.update({
      simTime: `${stats.time.toFixed(2)} s`,
      metric: shown,
      contacts: `${stats.contacts}${asleep}${full}`,
      ...(stats.gpuFrameMs !== undefined ? { gpuFrame: `${stats.gpuFrameMs.toFixed(2)} ms` } : {}),
    });
  }, [world, stats, hud]);

  useFrame(() => {
    if (!world) return;
    const w = fpsWindow.current;
    w.frames++;
    const now = performance.now();
    if (now - w.start <= FPS_WINDOW_MS) return;
    const elapsed = now - w.start;
    hud.update({
      fps: ((w.frames * 1000) / elapsed).toFixed(0),
      realTimeFactor: running ? `${(((world.sim.time - w.simStart) * 1000) / elapsed).toFixed(2)}x` : '-',
    });
    fpsWindow.current = { frames: 0, start: now, simStart: world.sim.time };
  });
  return null;
}

interface HudProps {
  hud: HudStore;
  title: string;
  /** The folder of the scene the heading names; another world still showing gets the plain heading. */
  sceneUrl: string;
  controls: SceneControls;
  setCompare: (enabled: boolean) => void;
  togglePlay: () => void;
  reset: () => void;
  retune: (tuning: SolverTuning) => void;
  collision: boolean;
  setCollision: (collision: boolean) => void;
  onMenu?: () => void;
  children: ReactNode;
}

const FOLDED_KEY = 'hudFolded';

function storedFolded() {
  try {
    return localStorage.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

function storeFolded(folded: boolean) {
  try {
    localStorage.setItem(FOLDED_KEY, folded ? '1' : '0');
  } catch {
    // Storage is unavailable, e.g. in a private window; the panel just forgets.
  }
}

function Hud({ hud, title, sceneUrl, controls, setCompare, togglePlay, reset, retune, collision, setCollision, onMenu, children }: HudProps) {
  const state = useSyncExternalStore(hud.subscribe, hud.get, hud.get);
  const [folded, setFolded] = useState(storedFolded);
  const fold = (next: boolean) => {
    setFolded(next);
    storeFolded(next);
  };
  if (state.status.kind === 'unsupported') {
    return (
      <div style={styles.notice}>
        <p style={styles.noticeText}>
          This live demo needs a desktop browser with WebGPU subgroups, such as a recent Chrome or Edge.
          <br />
          <span style={styles.muted}>{state.status.reason}.</span>
        </p>
      </div>
    );
  }
  const compare = state.scene?.json.info.compare;
  const defaults = state.solverDefaults;
  const solver: SolverState | null = defaults && {
    substeps: controls.tuning.substeps ?? defaults.substeps,
    iterations: controls.tuning.iterations ?? defaults.iterations,
    sleeping: controls.tuning.sleeping ?? defaults.sleeping,
    momentum: controls.tuning.momentum ?? defaults.momentum,
  };
  return (
    <>
      <div style={{ ...styles.hud, ...(folded ? styles.hudFolded : {}) }}>
        <div style={{ ...styles.head, ...(folded ? styles.headFolded : {}) }}>
          <h1 style={styles.title}>{state.scene?.base === sceneUrl ? title : PLAIN_TITLE}</h1>
          <button
            type="button"
            style={styles.fold}
            onClick={() => fold(!folded)}
            aria-label={folded ? 'Show panel' : 'Hide panel'}
            title={folded ? 'Show panel' : 'Hide panel'}
          >
            {folded ? '▸' : '▾'}
          </button>
        </div>
        <div hidden={folded}>
          <Stats state={state} />
          <div style={{ ...styles.muted, marginTop: 6 }}>Drag an object to pull it; scroll while dragging to change depth.</div>
          {children}
          {compare && <Toggle name="compare" label={compare.label} checked={!controls.compareOff} onChange={setCompare} style={styles.compare} />}
          {solver && <SolverControls solver={solver} retune={retune} collision={collision} setCollision={setCollision} />}
          {onMenu && (
            <button type="button" style={styles.button} onClick={onMenu}>
              Menu
            </button>
          )}
          <button type="button" style={styles.button} onClick={togglePlay}>
            {controls.running ? 'Pause' : 'Play'}
          </button>
          <button type="button" style={styles.button} onClick={reset}>
            Reset
          </button>
        </div>
      </div>
      {state.status.kind === 'loading' && <div style={styles.overlay}>Loading scene...</div>}
      {state.status.kind === 'error' && <div style={{ ...styles.overlay, ...styles.error }}>{state.status.message}</div>}
    </>
  );
}

function Stats({ state }: { state: HudState }) {
  const rows: [string, string, string, string?][] = [
    ['time', 'sim time', state.simTime],
    ['fps', 'display fps', state.fps],
    ['rtf', 'real-time factor', state.realTimeFactor],
    ['gpu', 'physics GPU / frame', state.gpuFrame],
    ['contacts', 'contacts', state.contacts],
    ['load', 'scene load', state.loadTime, state.loadStages],
  ];
  if (state.metric) rows.push(['metric', ...state.metric]);
  return rows.map(([key, label, value, detail]) => (
    <div key={key} style={styles.row}>
      <span>{label}</span>
      <span style={styles.value} data-stat={key} title={detail}>
        {value}
      </span>
    </div>
  ));
}

const SUBSTEP_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];
const ITERATION_CHOICES = [4, 6, 8, 10, 12, 16, 20, 24, 32];

interface SolverControlsProps {
  solver: SolverState;
  retune: (tuning: SolverTuning) => void;
  collision: boolean;
  setCollision: (collision: boolean) => void;
}

function SolverControls({ solver, retune, collision, setCollision }: SolverControlsProps) {
  const iterations = ITERATION_CHOICES.includes(solver.iterations) ? ITERATION_CHOICES : [...ITERATION_CHOICES, solver.iterations];
  const change = (patch: Partial<SolverState>) => retune({ ...solver, ...patch });
  return (
    <div style={styles.solverRow}>
      <label style={styles.field}>
        substeps
        <select style={styles.control} value={solver.substeps} onChange={(e) => change({ substeps: +e.target.value })} aria-label="substeps">
          {SUBSTEP_CHOICES.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <label style={styles.field}>
        iterations
        <select style={styles.control} value={solver.iterations} onChange={(e) => change({ iterations: +e.target.value })} aria-label="iterations">
          {iterations.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <Toggle name="sleeping" label="sleeping" checked={solver.sleeping} onChange={(sleeping) => change({ sleeping })} />
      <Toggle name="momentum" label="momentum" checked={solver.momentum} onChange={(momentum) => change({ momentum })} />
      <Toggle name="collision" label="collision" checked={collision} onChange={setCollision} />
    </div>
  );
}

interface ToggleProps {
  name: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  style?: CSSProperties;
}

function Toggle({ name, label, checked, onChange, style }: ToggleProps) {
  return (
    <label style={{ ...styles.toggle, ...style }}>
      <input type="checkbox" aria-label={name} checked={checked} onChange={(e) => onChange(e.target.checked)} style={checkboxStyle(checked)} />
      {label}
    </label>
  );
}
