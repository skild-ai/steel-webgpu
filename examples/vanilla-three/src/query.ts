import type { SimOptions } from 'steel-webgpu';

/** The solver controls; unset fields keep the scene's own values. */
export interface SolverTuning {
  substeps?: number;
  iterations?: number;
  sleeping?: boolean;
  momentum?: boolean;
}

/** What the page URL can set: `?demo=&paused&without&ss=&it=&sleep=&nest=&reg=&warm=&gallery&collision`. */
export interface ViewerQuery {
  scene: string;
  paused: boolean;
  compareOff: boolean;
  tuning: SolverTuning;
  solver: Pick<SimOptions, 'regularization' | 'warmStart'>;
  gallery: boolean;
  collision: boolean;
}

const DEFAULT_SCENE = 'bolt_sweep';

const optionalNumber = (q: URLSearchParams, key: string) => (q.has(key) ? parseFloat(q.get(key)!) : undefined);
// The Sim spreads its options over the scene's own values, so an unset key must be absent rather than undefined.
const definedOnly = <T extends object>(options: T) => Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as Partial<T>;
const optionalFlag = (q: URLSearchParams, key: string) => (q.has(key) ? q.get(key) !== '0' : undefined);
const flagValue = (flag: boolean | undefined) => (flag === undefined ? undefined : Number(flag));

export function readQuery(): ViewerQuery {
  const q = new URLSearchParams(location.search);
  return {
    scene: q.get('demo') || DEFAULT_SCENE,
    paused: q.has('paused'),
    compareOff: q.has('without'),
    tuning: { substeps: optionalNumber(q, 'ss'), iterations: optionalNumber(q, 'it'), sleeping: optionalFlag(q, 'sleep'), momentum: optionalFlag(q, 'nest') },
    solver: definedOnly({ regularization: optionalNumber(q, 'reg'), warmStart: optionalNumber(q, 'warm') }),
    gallery: q.has('gallery'),
    collision: q.has('collision'),
  };
}

/** Rewrites query flags in place; null or undefined removes one, '' keeps a bare flag like ?gallery. */
export function setQuery(flags: Record<string, string | number | null | undefined>) {
  const q = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(flags)) {
    if (value === null || value === undefined) q.delete(key);
    else q.set(key, String(value));
  }
  history.replaceState(null, '', `?${q.toString().replace(/(gallery|without|paused|collision)=(&|$)/g, '$1$2')}`);
}

export const tuningFlags = ({ substeps, iterations, sleeping, momentum }: SolverTuning) => ({
  ss: substeps,
  it: iterations,
  sleep: flagValue(sleeping),
  nest: flagValue(momentum),
});
