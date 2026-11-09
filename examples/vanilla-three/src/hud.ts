import type { LoadedScene, SceneEntry } from 'steel-webgpu';
import { byCategory } from './byCategory';
import type { SolverTuning } from './query';

export type HudStat = 'time' | 'fps' | 'rtf' | 'gpu' | 'contacts' | 'load' | 'metric';

/** The scene's own solver settings, which the controls show until the viewer tunes them. */
export interface SolverState {
  substeps: number;
  iterations: number;
  sleeping: boolean;
  momentum: boolean;
}

export const PLAIN_TITLE = 'Steel WebGPU';
const FOLDED_KEY = 'hudFolded';

export interface HudActions {
  pick(scene: string): void;
  menu(): void;
  togglePlay(): void;
  reset(): void;
  setCompare(enabled: boolean): void;
  retune(tuning: SolverTuning): void;
  setCollision(collision: boolean): void;
}

const SUBSTEP_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];
const ITERATION_CHOICES = [4, 6, 8, 10, 12, 16, 20, 24, 32];

const element = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const fillOptions = (select: HTMLSelectElement, values: number[]) => select.replaceChildren(...values.map((v) => new Option(String(v))));

/** The panel over the canvas: stats, the scene picker, play/pause/reset, the compare toggle and the solver controls. */
export class Hud {
  private readonly root = element('#hud');
  private readonly title = element('#title');
  private readonly scenePicker = element<HTMLSelectElement>('#scene');
  private readonly about = element('#about');
  private readonly compare = element<HTMLLabelElement>('#compare');
  private readonly compareBox = element<HTMLInputElement>('#compare input');
  private readonly substeps = element<HTMLSelectElement>('#substeps');
  private readonly iterations = element<HTMLSelectElement>('#iterations');
  private readonly sleeping = element<HTMLInputElement>('#sleeping');
  private readonly momentum = element<HTMLInputElement>('#momentum');
  private readonly collision = element<HTMLInputElement>('#collision');
  private readonly foldButton = element<HTMLButtonElement>('#fold');
  private readonly metricRow = element('#metric-row');
  private readonly play = element<HTMLButtonElement>('#play');
  private readonly overlay = element('#overlay');
  private scenes: SceneEntry[] = [];

  constructor(actions: HudActions) {
    fillOptions(this.substeps, SUBSTEP_CHOICES);
    const retune = () =>
      actions.retune({ substeps: +this.substeps.value, iterations: +this.iterations.value, sleeping: this.sleeping.checked, momentum: this.momentum.checked });
    this.substeps.onchange = this.iterations.onchange = this.sleeping.onchange = this.momentum.onchange = retune;
    this.foldButton.onclick = () => this.fold(!this.root.classList.contains('folded'), true);
    this.fold(storedFolded(), false);
    this.scenePicker.onchange = () => actions.pick(this.scenePicker.value);
    this.compareBox.onchange = () => actions.setCompare(this.compareBox.checked);
    this.collision.onchange = () => actions.setCollision(this.collision.checked);
    element('#menu').onclick = actions.menu;
    this.play.onclick = actions.togglePlay;
    element('#reset').onclick = actions.reset;
    this.root.hidden = false;
  }

  listScenes(scenes: SceneEntry[], current: string) {
    this.scenes = scenes;
    this.scenePicker.replaceChildren(
      ...byCategory(scenes).map(([category, entries]) => {
        const group = document.createElement('optgroup');
        group.label = category;
        group.append(...entries.map((s) => new Option(s.title, s.name)));
        return group;
      }),
    );
    this.showPicked(current);
  }

  showPicked(scene: string) {
    this.scenePicker.value = scene;
    this.about.textContent = this.scenes.find((s) => s.name === scene)?.about ?? '';
  }

  /** The scene's display title from the index, or its folder name. */
  titleOf(scene: string) {
    return this.scenes.find((s) => s.name === scene)?.title ?? scene;
  }

  loading() {
    this.title.textContent = PLAIN_TITLE;
    for (const stat of ['time', 'fps', 'rtf', 'gpu', 'contacts'] as const) this.set(stat, stat === 'time' ? '0' : '-');
    this.showMetric(null);
    this.set('load', 'loading...');
    this.showOverlay('Loading scene...');
  }

  showScene(name: string, scene: LoadedScene, solver: SolverState, compareOff: boolean) {
    this.showOverlay(null);
    this.title.textContent = this.titleOf(name);
    const compare = scene.json.info.compare;
    this.compare.hidden = !compare;
    if (compare) {
      this.compare.querySelector('span')!.textContent = compare.label;
      this.compareBox.checked = !compareOff;
    }
    this.showSolver(solver);
  }

  showCollision(collision: boolean) {
    this.collision.checked = collision;
  }

  showSolver({ substeps, iterations, sleeping, momentum }: SolverState) {
    fillOptions(this.iterations, ITERATION_CHOICES.includes(iterations) ? ITERATION_CHOICES : [...ITERATION_CHOICES, iterations]);
    this.substeps.value = String(substeps);
    this.iterations.value = String(iterations);
    this.sleeping.checked = sleeping;
    this.momentum.checked = momentum;
  }

  showPlaying(running: boolean) {
    this.play.textContent = running ? 'Pause' : 'Play';
  }

  set(stat: HudStat, value: string, detail?: string) {
    const target = element(`[data-stat="${stat}"]`);
    target.textContent = value;
    if (detail !== undefined) target.title = detail;
  }

  /** The scene's progress label and value; the row hides when the scene tracks nothing. */
  showMetric(metric: [string, string] | null) {
    this.metricRow.hidden = metric === null;
    if (!metric) return;
    element('#metric-label').textContent = metric[0];
    this.set('metric', metric[1]);
  }

  showError(message: string) {
    this.showOverlay(message, true);
  }

  private fold(folded: boolean, remember: boolean) {
    this.root.classList.toggle('folded', folded);
    this.foldButton.textContent = folded ? '▸' : '▾';
    this.foldButton.title = folded ? 'Show panel' : 'Hide panel';
    this.foldButton.setAttribute('aria-label', this.foldButton.title);
    if (remember) storeFolded(folded);
  }

  private showOverlay(text: string | null, error = false) {
    this.overlay.hidden = text === null;
    this.overlay.textContent = text ?? '';
    this.overlay.classList.toggle('error', error);
  }
}

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
