import { Physics, Scene, useSimStats, type SimStatsSample } from '@steel-webgpu/react';
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Playground } from './Playground';

type View = 'folder' | 'playground';

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};
const currentView = (): View => (location.hash === '#playground' ? 'playground' : 'folder');

export function App() {
  const view = useSyncExternalStore(subscribeToHash, currentView);
  const [stats, setStats] = useState<SimStatsSample | null>(null);

  return (
    <div style={styles.root}>
      <Physics
        style={styles.canvas}
        fallback={<p style={styles.message}>Requesting a WebGPU device...</p>}
        unsupported={(reason) => <Unsupported reason={reason} />}
      >
        {view === 'folder' ? (
          <Scene src="/assets/bolt_sweep">
            <StatsFeed onSample={setStats} />
          </Scene>
        ) : (
          <Scene>
            <Playground />
            <StatsFeed onSample={setStats} />
          </Scene>
        )}
      </Physics>
      <nav style={styles.panel}>
        <a href="#folder" style={view === 'folder' ? styles.active : styles.link}>
          Scene folder
        </a>
        <a href="#playground" style={view === 'playground' ? styles.active : styles.link}>
          Declarative
        </a>
        <span data-stat="time">{stats ? `${stats.time.toFixed(2)} s` : 'loading'}</span>
        <span data-stat="contacts">{stats ? `${stats.contacts} contacts` : ''}</span>
      </nav>
    </div>
  );
}

function StatsFeed({ onSample }: { onSample: (stats: SimStatsSample | null) => void }) {
  const stats = useSimStats({ hz: 2 });
  useEffect(() => onSample(stats), [stats, onSample]);
  return null;
}

const Unsupported = ({ reason }: { reason: string }) => <p style={styles.message}>This browser cannot run steel-webgpu: {reason}</p>;

const styles = {
  root: { position: 'relative', width: '100%', height: '100%' },
  canvas: { position: 'absolute', inset: 0 },
  panel: {
    position: 'absolute',
    top: 12,
    left: 12,
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    padding: '8px 12px',
    borderRadius: 8,
    background: 'rgba(20, 23, 27, 0.8)',
  },
  link: { color: '#9fb3c8' },
  active: { color: '#ffffff', fontWeight: 600 },
  message: { display: 'grid', placeItems: 'center', height: '100%', margin: 0, padding: 24, textAlign: 'center' },
} satisfies Record<string, CSSProperties>;
