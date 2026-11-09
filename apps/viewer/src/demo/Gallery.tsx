import { useEffect, useRef } from 'react';
import { prefetchScene, ScenePreviewer } from '@steel-webgpu/three';
import type { SceneEntry } from 'steel-webgpu';
import { byCategory } from './byCategory';
import { galleryStyles as css } from './galleryStyles';

interface GalleryProps {
  scenes: SceneEntry[];
  current: string;
  assetsBase: string;
  onPick: (name: string) => void;
  onClose: () => void;
}

/** Every scene as a card under its category; previews render from each scene's initial state, visible cards first. */
export function Gallery({ scenes, current, assetsBase, onPick, onClose }: GalleryProps) {
  const grid = useRef<HTMLDivElement>(null);
  const previewCanvas = useRef<HTMLCanvasElement>(null);
  const thumbs = useRef(new Map<string, HTMLCanvasElement>());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const previewer = new ScenePreviewer(previewCanvas.current!);
    const queue: string[] = [];
    const done = new Set<string>();
    const status = { open: true, pumping: false };
    const pump = async () => {
      if (status.pumping) return;
      status.pumping = true;
      while (status.open && queue.length) {
        const name = queue.shift()!;
        const out = thumbs.current.get(name);
        if (done.has(name) || !out) continue;
        done.add(name);
        await previewer.draw(`${assetsBase}/${name}`, out).catch((e) => status.open && console.error('preview', name, e));
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
      { root: grid.current?.parentElement, rootMargin: '200px' },
    );
    for (const card of grid.current!.querySelectorAll('[data-name]')) seen.observe(card);
    queue.push(...scenes.map((s) => s.name));
    void pump();
    grid.current!.querySelector<HTMLElement>('[data-current]')?.focus({ preventScroll: true });
    return () => {
      status.open = false;
      seen.disconnect();
      void previewer.dispose();
    };
  }, [scenes, assetsBase]);

  return (
    <div style={css.overlay} role="dialog" aria-label="Scene gallery">
      <header style={css.header}>
        <h2 style={css.heading}>
          Scenes<span style={css.count}>{scenes.length}</span>
        </h2>
        <button type="button" style={css.close} onClick={onClose}>
          Close
        </button>
      </header>
      <div ref={grid} style={css.sections}>
        {byCategory(scenes).map(([category, entries], section) => (
          <section key={category}>
            <h3 style={{ ...css.section, ...(section === 0 ? css.firstSection : {}) }}>{category}</h3>
            <div style={css.grid}>
              {entries.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  data-name={s.name}
                  data-current={s.name === current || undefined}
                  style={{ ...css.card, ...(s.name === current ? css.current : {}) }}
                  onClick={() => onPick(s.name)}
                  onPointerEnter={() => prefetchScene(`${assetsBase}/${s.name}`)}
                  onFocus={() => prefetchScene(`${assetsBase}/${s.name}`)}
                >
                  <canvas
                    width={720}
                    height={450}
                    style={css.thumb}
                    ref={(c) => {
                      if (c) thumbs.current.set(s.name, c);
                    }}
                  />
                  <div style={css.name}>{s.title}</div>
                  <div style={css.about} title={s.about}>
                    {s.short ?? s.about}
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <canvas ref={previewCanvas} style={css.previewCanvas} />
    </div>
  );
}
