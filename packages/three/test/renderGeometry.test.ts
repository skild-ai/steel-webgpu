import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { expect, test } from 'vite-plus/test';
import type { VisualMeshData, MeshRef } from 'steel-webgpu';
import { geometryKernels } from '../src/renderGeometry';

const { build, meshData } = geometryKernels();
const noMeshFiles = (): VisualMeshData => {
  throw new Error('no mesh files');
};

function randomBin(floats: number[], ints: number[]) {
  const bin = new ArrayBuffer((floats.length + ints.length) * 4);
  new Float32Array(bin, 0, floats.length).set(floats);
  new Uint32Array(bin, floats.length * 4, ints.length).set(ints);
  return bin;
}

const random = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

test('mesh normals match three computeVertexNormals bit for bit, degenerate triangles included', () => {
  const next = random(7);
  const vertexCount = 200;
  const positions = Array.from({ length: vertexCount * 3 }, next);
  const index = Array.from({ length: 900 }, () => Math.floor(((next() + 1) / 2) * vertexCount) % vertexCount);
  index.splice(0, 3, 5, 5, 9);
  const bin = randomBin(positions, index);
  const mesh: MeshRef = { v: { off: 0, n: positions.length }, i: { off: positions.length * 4, n: index.length } };
  const built = build(bin, { key: 'm', kind: 'mesh', mesh }, (ref) => meshData({ bin, files: new Map() }, ref));

  const three = new BufferGeometry();
  three.setAttribute('position', new BufferAttribute(new Float32Array(bin, 0, positions.length), 3));
  three.setIndex(new BufferAttribute(new Uint32Array(bin, positions.length * 4, index.length), 1));
  three.computeVertexNormals();
  expect(built.normal).toEqual(three.attributes.normal.array);
});

test('hull faces fan into triangles with flat normals, as three builds them from the same positions', () => {
  const cube = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const faceStart = faces.reduce((starts, f) => [...starts, starts.at(-1)! + f.length], [0]);
  const faceVerts = faces.flat();
  const bin = randomBin(cube, [...faceStart, ...faceVerts]);
  const off = cube.length * 4;
  const built = build(
    bin,
    {
      key: 'h',
      kind: 'hull',
      hull: {
        verts: { off: 0, n: cube.length },
        face_start: { off, n: faceStart.length },
        face_verts: { off: off + faceStart.length * 4, n: faceVerts.length },
        nf: 6,
      },
    },
    noMeshFiles,
  );

  const corners = faces.flatMap((f) => f.slice(1, -1).flatMap((_, k) => [f[0], f[k + 1], f[k + 2]]));
  const three = new BufferGeometry();
  three.setAttribute(
    'position',
    new Float32BufferAttribute(
      corners.flatMap((c) => cube.slice(c * 3, c * 3 + 3)),
      3,
    ),
  );
  three.computeVertexNormals();
  expect(built.position).toEqual(three.attributes.position.array);
  expect(built.normal).toEqual(three.attributes.normal.array);
});

test('a shared mesh file holds positions, u16 indices, then UVs at the next 4-byte boundary', () => {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const index = [0, 1, 2];
  const uvs = [0, 0, 1, 0, 0, 1];
  const file = new ArrayBuffer(36 + 8 + 24);
  new Float32Array(file, 0, 9).set(positions);
  new Uint16Array(file, 36, 3).set(index);
  new Float32Array(file, 44, 6).set(uvs);
  const ref: MeshRef = { file: '../shared/meshes/a.bin', nv: 3, ni: 3, index: 'u16', uv: true };
  const data = meshData({ bin: new ArrayBuffer(0), files: new Map([[ref.file, file]]) }, ref);
  expect([...data.pos]).toEqual(positions);
  expect(data.idx).toBeInstanceOf(Uint16Array);
  expect([...data.idx]).toEqual(index);
  expect([...data.uv!]).toEqual(uvs);
});

test('creased mesh normals match three toCreasedNormals at 30 degrees, with UVs per corner', () => {
  const next = random(11);
  const vertexCount = 120;
  const positions = new Float32Array(Array.from({ length: vertexCount * 3 }, next));
  const uvs = new Float32Array(Array.from({ length: vertexCount * 2 }, next));
  const index = new Uint32Array(Array.from({ length: 600 }, () => Math.floor(((next() + 1) / 2) * vertexCount) % vertexCount));
  const ref: MeshRef = { v: { off: 0, n: 0 }, i: { off: 0, n: 0 }, crease: true };
  const built = build(new ArrayBuffer(0), { key: 'c', kind: 'mesh', mesh: ref }, () => ({ pos: positions, idx: index, uv: uvs }));

  const three = new BufferGeometry();
  three.setAttribute('position', new BufferAttribute(positions, 3));
  three.setAttribute('uv', new BufferAttribute(uvs, 2));
  three.setIndex(new BufferAttribute(index, 1));
  const creased = toCreasedNormals(three, Math.PI / 6);
  expect(built.position).toEqual(creased.attributes.position.array);
  expect(built.uv).toEqual(creased.attributes.uv.array);
  expect(built.normal).toEqual(creased.attributes.normal.array);
});
