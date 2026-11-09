import { prefetchScene, ScenePreviewer } from '@steel-webgpu/three';
import type { SceneEntry } from 'steel-webgpu';
import { byCategory } from './byCategory';

const THUMB_WIDTH = 720;
const THUMB_HEIGHT = 450;

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

/**
 * Every scene as a card under its category, over the viewer. Previews render from each scene's initial state on a second renderer,
 * visible cards first; hovering a card prefetches its scene. Built on open and torn down on close.
 */
export class Gallery {
  private close: (() => void) | null = null;

  constructor(
    private readonly scenes: SceneEntry[],
    private readonly assetsBase: string,
    private readonly onPick: (scene: string) => void,
    private readonly onClose: () => void,
  ) {}

  get isOpen() {
    return this.close !== null;
  }

  open(current: string) {
    if (this.close) return;
    const thumbs = new Map<string, HTMLCanvasElement>();
    const cards: HTMLElement[] = [];
    const sections = byCategory(this.scenes).flatMap(([category, entries]) => {
      const sectionCards = entries.map((s) => this.card(s, s.name === current, thumbs));
      cards.push(...sectionCards);
      return [create('h3', { className: 'section', textContent: category }), create('div', { className: 'grid' }, ...sectionCards)];
    });
    const closeButton = create('button', { type: 'button', textContent: 'Close', onclick: this.onClose });
    const header = create('header', {}, create('h2', {}, 'Scenes', create('span', { textContent: String(this.scenes.length) })), closeButton);
    const previewCanvas = create('canvas', { className: 'preview' });
    const dialog = create('div', { className: 'gallery' }, header, create('div', { className: 'sections' }, ...sections), previewCanvas);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Scene gallery');
    document.body.append(dialog);

    const stopPreviews = this.renderPreviews(previewCanvas, dialog, cards, thumbs);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && this.onClose();
    addEventListener('keydown', onKey);
    cards.find((c) => c.classList.contains('current'))?.focus({ preventScroll: true });
    this.close = () => {
      removeEventListener('keydown', onKey);
      stopPreviews();
      dialog.remove();
    };
  }

  hide() {
    this.close?.();
    this.close = null;
  }

  private card(scene: SceneEntry, current: boolean, thumbs: Map<string, HTMLCanvasElement>) {
    const thumb = create('canvas', { width: THUMB_WIDTH, height: THUMB_HEIGHT });
    thumbs.set(scene.name, thumb);
    const prefetch = () => prefetchScene(`${this.assetsBase}/${scene.name}`);
    const card = create(
      'button',
      { type: 'button', className: current ? 'card current' : 'card', onclick: () => this.onPick(scene.name), onpointerenter: prefetch, onfocus: prefetch },
      thumb,
      create('div', { className: 'name', textContent: scene.title }),
      create('div', { className: 'about', textContent: scene.short ?? scene.about, title: scene.about }),
    );
    card.dataset.name = scene.name;
    return card;
  }

  private renderPreviews(canvas: HTMLCanvasElement, scroller: HTMLElement, cards: HTMLElement[], thumbs: Map<string, HTMLCanvasElement>) {
    const previewer = new ScenePreviewer(canvas);
    const queue = this.scenes.map((s) => s.name);
    const done = new Set<string>();
    const status = { open: true, pumping: false };
    const pump = async () => {
      if (status.pumping) return;
      status.pumping = true;
      while (status.open && queue.length) {
        const name = queue.shift()!;
        if (done.has(name)) continue;
        done.add(name);
        await previewer.draw(`${this.assetsBase}/${name}`, thumbs.get(name)!).catch((e) => status.open && console.error('preview', name, e));
      }
      status.pumping = false;
    };
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          seen.unobserve(e.target);
          queue.unshift((e.target as HTMLElement).dataset.name!);
        }
        void pump();
      },
      { root: scroller, rootMargin: '200px' },
    );
    for (const card of cards) seen.observe(card);
    void pump();
    return () => {
      status.open = false;
      seen.disconnect();
      void previewer.dispose();
    };
  }
}
