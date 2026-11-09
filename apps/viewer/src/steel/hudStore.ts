import type { LoadedScene } from '@skild-ai/steel-webgpu';

export interface SolverState {
  substeps: number;
  iterations: number;
  sleeping: boolean;
  momentum: boolean;
}

export type SteelStatus =
  | { kind: 'checking' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'loading' }
  | { kind: 'running' }
  | { kind: 'error'; message: string };

export interface HudState {
  status: SteelStatus;
  simTime: string;
  fps: string;
  realTimeFactor: string;
  gpuFrame: string;
  contacts: string;
  /** The scene's progress label and value, null when it tracks nothing. */
  metric: [string, string] | null;
  /** The loaded scene, null while one loads. */
  scene: LoadedScene | null;
  /** The Sim's own substeps, iterations, sleeping and momentum, before the viewer's tuning. */
  solverDefaults: SolverState | null;
  loadTime: string;
  /** Per-stage load times in ms, e.g. for a tooltip on the load time. */
  loadStages: string;
}

export const initialHud: HudState = {
  status: { kind: 'checking' },
  simTime: '0',
  fps: '-',
  realTimeFactor: '-',
  gpuFrame: '-',
  contacts: '-',
  metric: null,
  scene: null,
  solverDefaults: null,
  loadTime: '-',
  loadStages: '',
};

/** A tiny external store so the HUD re-renders on its own, without re-rendering the canvas tree. */
export class HudStore {
  private state = initialHud;
  private readonly listeners = new Set<() => void>();

  readonly get = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<HudState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
