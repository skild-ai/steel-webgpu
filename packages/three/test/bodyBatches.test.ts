import { expect, test } from 'vite-plus/test';
import { layoutScene } from '../src/bodyBatches';
import type { SceneJson } from 'steel-webgpu';

const range = (off: number) => ({ off, n: 3 });
const hull = (off: number) => ({ verts: range(off), face_start: range(off + 100), face_verts: range(off + 200), nf: 1 });
const identity = [0, 0, 0, 0, 0, 0, 1] as const;

const scene: SceneJson = {
  demo: 'test',
  fps: 60,
  bodies: {
    count: 3,
    com: [
      [0, 0, 0.1],
      [0, 0, 0],
      [1, 1, 1],
    ],
    q: [],
  },
  visuals: [
    { body: 0, mesh: { v: range(0), i: range(10) }, color: [1, 0, 0], xf: [0.5, 0, 0, 0, 0, 0, 1] },
    { body: -1, mesh: { v: range(20), i: range(30) }, color: [1, 0, 0], xf: [...identity] },
  ],
  shapes: [
    { body: 0, xf: [...identity], color: [0, 1, 0], hull: hull(1000) },
    { body: 1, xf: [...identity], color: [0, 1, 0], hull: hull(2000) },
    { body: 2, xf: [...identity], color: [0, 1, 0], hull: hull(2000) },
    { body: -1, xf: [0, 0, -1, 0, 0, 0, 1], color: [0, 0, 1], hull: hull(3000) },
    { body: -1, xf: [...identity], color: [0, 0, 1], plane: {} },
  ],
  info: {},
};

test('draws visuals of bodies, and hulls only for bodies without visuals', () => {
  const { batches, unique } = layoutScene(scene);
  expect(batches.map((b) => [b.source.kind, b.pieces.map((p) => p.body)])).toEqual([['hull', [1, 2]]]);
  expect(unique.map((u) => [u.source.kind, u.piece.body])).toEqual([['mesh', 0]]);
});

test('instances shared geometry whatever its colors and keeps unique pieces apart', () => {
  const pieces: SceneJson = {
    ...scene,
    visuals: [
      ...[0, 1].map((body) => ({ body, mesh: { v: range(body * 50), i: range(body * 50 + 10) }, color: [1, 0, 0] as const, xf: [...identity] as const })),
      { body: 2, mesh: { v: range(0), i: range(10) }, color: [0, 0, 1], xf: [...identity] },
    ],
    shapes: [],
  } as SceneJson;
  const { batches, unique } = layoutScene(pieces);
  expect(batches.map((b) => b.pieces.map((p) => [p.body, p.color]))).toEqual([
    [
      [0, [1, 0, 0]],
      [2, [0, 0, 1]],
    ],
  ]);
  expect(unique.map((u) => u.piece.body)).toEqual([1]);
});

test('places each piece relative to its body COM', () => {
  const { batches, unique } = layoutScene(scene);
  expect(unique[0].piece.offset).toEqual([0.5, 0, -0.1]);
  expect(batches[0].pieces[1].offset).toEqual([-1, -1, -1]);
});

test('keeps world visuals, static hulls and planes out of the posed batches', () => {
  const { statics, planes } = layoutScene(scene);
  expect(statics.map((s) => [s.source.kind, s.xf[2]])).toEqual([
    ['mesh', 0],
    ['hull', -1],
  ]);
  expect(planes).toHaveLength(1);
});

test('draws a shape flagged visible even under a visual, and never one flagged hidden', () => {
  const flagged: SceneJson = {
    ...scene,
    shapes: [
      { body: 0, xf: [...identity], color: [0, 1, 0], hull: hull(1000), visible: true },
      { body: 1, xf: [...identity], color: [0, 1, 0], hull: hull(2000), visible: false },
    ],
  };
  const { batches, unique } = layoutScene(flagged);
  const hullBodies = [...batches.flatMap((b) => b.pieces), ...unique.filter((u) => u.source.kind === 'hull').map((u) => u.piece)].map((p) => p.body);
  expect(hullBodies).toEqual([0]);
});

test('keeps textured pieces instanced so their UVs survive', () => {
  const textured: SceneJson = {
    ...scene,
    visuals: [{ body: 0, mesh: { v: range(0), i: range(10), uv: range(20), texture: 'wood.png' }, color: [1, 1, 1], xf: [...identity] }],
    shapes: [],
  };
  expect(layoutScene(textured).batches.map((b) => b.texture)).toEqual(['wood.png']);
});
