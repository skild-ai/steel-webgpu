import type { CSSProperties } from 'react';

const panel = 'rgba(20, 24, 28, 0.82)';
const border = '1px solid #45525e';
const control = '#2c3640';
const accent = '#9fd3ff';

const svg = (markup: string) => `url("data:image/svg+xml,${encodeURIComponent(markup)}")`;
const chevron = svg(
  "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' fill='none' stroke='#9aa7b2' stroke-width='1.5'/></svg>",
);
const checkmark = svg(
  "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='8'><path d='M1 4l3 3 5-6' fill='none' stroke='#14181c' stroke-width='1.8'/></svg>",
);

const controlBase: CSSProperties = {
  height: 28,
  boxSizing: 'border-box',
  backgroundColor: control,
  color: '#e6ebef',
  border,
  borderRadius: 5,
  font: 'inherit',
  cursor: 'pointer',
};

const selectBase: CSSProperties = {
  ...controlBase,
  appearance: 'none',
  padding: '0 26px 0 8px',
  backgroundImage: chevron,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 9px center',
};

const checkboxBase: CSSProperties = {
  appearance: 'none',
  flex: 'none',
  width: 16,
  height: 16,
  margin: 0,
  border,
  borderRadius: 4,
  background: control,
  cursor: 'pointer',
};

export const checkboxStyle = (checked: boolean): CSSProperties =>
  checked ? { ...checkboxBase, border: `1px solid ${accent}`, background: `${accent} ${checkmark} no-repeat center` } : checkboxBase;

export const styles = {
  root: {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    background: '#1d2125',
    color: '#e6ebef',
    font: '13px/1.4 ui-monospace, Menlo, monospace',
  },
  canvas: { display: 'block', width: '100%', height: '100%', touchAction: 'none' },
  hud: { position: 'absolute', top: 12, left: 12, background: panel, padding: '10px 12px', borderRadius: 8, minWidth: 250, maxWidth: 'calc(100% - 48px)' },
  hudFolded: { minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 },
  headFolded: { marginBottom: 0 },
  title: { fontSize: 13, margin: 0, fontWeight: 600 },
  fold: { margin: 0, padding: '0 6px', background: 'none', border: 'none', color: '#9aa7b2', fontFamily: 'inherit', fontSize: 14, cursor: 'pointer' },
  row: { display: 'flex', justifyContent: 'space-between', gap: 16 },
  value: { color: accent },
  muted: { color: '#9aa7b2' },
  // Zero width keeps the description from widening the panel; it wraps to whatever width the rest sets.
  about: { color: '#9aa7b2', marginTop: 6, width: 0, minWidth: '100%' },
  toggle: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
  compare: { marginTop: 8 },
  solverRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', marginTop: 8 },
  field: { display: 'flex', alignItems: 'center', gap: 6 },
  button: { ...controlBase, marginTop: 8, marginRight: 6, padding: '0 10px' },
  control: selectBase,
  select: { ...selectBase, marginTop: 8, width: '100%' },
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
  },
  error: { color: '#ffb4a8', pointerEvents: 'auto' },
  notice: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center' },
  noticeText: { maxWidth: 420, margin: 0 },
} satisfies Record<string, CSSProperties>;
