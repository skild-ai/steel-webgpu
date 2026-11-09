import { useCallback, useEffect, useState } from 'react';
import { SteelDemo } from '../steel/SteelDemo';
import type { SolverTuning } from '../steel/SteelDemo';
import { byCategory } from './byCategory';
import { Gallery } from './Gallery';
import type { SceneEntry } from 'steel-webgpu';
import { styles } from '../steel/styles';

const ASSETS_BASE = `${import.meta.env.BASE_URL}assets`;
const DEFAULT_SCENE = 'bolt_sweep';

function tuningFrom(q: URLSearchParams): SolverTuning {
  return {
    substeps: optionalNumber(q, 'ss'),
    iterations: optionalNumber(q, 'it'),
    sleeping: optionalFlag(q, 'sleep'),
    momentum: optionalFlag(q, 'nest'),
  };
}

/** Rewrites query flags in place; null removes one, '' keeps a bare flag like ?gallery. */
function setQuery(flags: Record<string, string | number | null | undefined>) {
  const q = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(flags)) {
    if (value === null || value === undefined) q.delete(key);
    else q.set(key, String(value));
  }
  history.replaceState(null, '', `?${q.toString().replace(/(gallery|without|collision)=(&|$)/g, '$1$2')}`);
}

const optionalNumber = (q: URLSearchParams, key: string) => (q.has(key) ? parseFloat(q.get(key)!) : undefined);
const optionalFlag = (q: URLSearchParams, key: string) => (q.has(key) ? q.get(key) !== '0' : undefined);
const flagValue = (flag: boolean | undefined) => (flag === undefined ? null : Number(flag));
const PLAIN_TITLE = 'Steel WebGPU';

export function App() {
  const query = new URLSearchParams(location.search);
  const [scene, setScene] = useState(query.get('demo') || DEFAULT_SCENE);
  const [compareOff, setCompareOff] = useState(query.has('without'));
  const [scenes, setScenes] = useState<SceneEntry[]>([]);
  const [tuning, setTuning] = useState(() => tuningFrom(query));
  const [galleryOpen, setGalleryOpen] = useState(query.has('gallery'));
  const [collision, setCollision] = useState(query.has('collision'));

  useEffect(() => {
    const abort = new AbortController();
    fetch(`${ASSETS_BASE}/index.json`, { signal: abort.signal })
      .then((r) => r.json())
      .then(setScenes, (e) => abort.signal.aborted || console.error(e));
    return () => abort.abort();
  }, []);

  const entry = scenes.find((s) => s.name === scene);
  const title = entry?.title ?? scene;
  useEffect(() => {
    document.title = `${title} · ${PLAIN_TITLE}`;
  }, [title]);

  useEffect(() => {
    const onPopState = () => {
      const q = new URLSearchParams(location.search);
      setScene(q.get('demo') || DEFAULT_SCENE);
      setCompareOff(q.has('without'));
      setTuning(tuningFrom(q));
      setGalleryOpen(q.has('gallery'));
      setCollision(q.has('collision'));
    };
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  const pick = (name: string) => {
    // The collision view is a viewing preference, so it carries over to the next scene.
    history.pushState(null, '', `?demo=${name}${collision ? '&collision' : ''}`);
    setScene(name);
    setCompareOff(false);
    setTuning({});
    setGalleryOpen(false);
  };

  const showGallery = useCallback((open: boolean) => {
    setGalleryOpen(open);
    setQuery({ gallery: open ? '' : null });
  }, []);
  const closeGallery = useCallback(() => showGallery(false), [showGallery]);

  const retuned = (next: SolverTuning) => {
    setQuery({ ss: next.substeps, it: next.iterations, sleep: flagValue(next.sleeping), nest: flagValue(next.momentum) });
  };

  return (
    <>
      <SteelDemo
        scene={scene}
        title={title}
        assetsBase={ASSETS_BASE}
        paused={query.has('paused')}
        compareOff={compareOff}
        solver={{ regularization: optionalNumber(query, 'reg'), warmStart: optionalNumber(query, 'warm') }}
        tuning={tuning}
        onTuningChange={retuned}
        collision={collision}
        onCollisionChange={(on) => {
          setCollision(on);
          setQuery({ collision: on ? '' : null });
        }}
        onMenu={() => showGallery(true)}
        suspended={galleryOpen}
      >
        <select style={styles.select} value={scene} onChange={(e) => pick(e.target.value)} aria-label="Scene">
          {byCategory(scenes).map(([category, entries]) => (
            <optgroup key={category} label={category}>
              {entries.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div style={styles.about}>{entry?.about ?? ''}</div>
      </SteelDemo>
      {galleryOpen && scenes.length > 0 && (
        <Gallery
          scenes={scenes}
          current={scene}
          assetsBase={ASSETS_BASE}
          onPick={(name) => (name === scene ? closeGallery() : pick(name))}
          onClose={closeGallery}
        />
      )}
    </>
  );
}
