import type { HullRef, VisualMeshData, MeshRef } from '@skild-ai/steel-webgpu';
import { geometryKey, type GeometrySource, type SceneLayout } from './bodyBatches';

export type GeometryJob = { key: string; kind: 'mesh'; mesh: MeshRef } | { key: string; kind: 'hull'; hull: HullRef };

/** The buffers a scene's geometry is read from: scene.bin and the shared mesh files by their path in the scene. */
export interface GeometryFiles {
  bin: ArrayBuffer;
  files: ReadonlyMap<string, ArrayBuffer>;
}

/**
 * What a piece's BufferGeometry needs beyond the scene's own buffers: normals and, for hulls and creased meshes, which
 * are drawn unindexed, their positions and UVs per triangle corner.
 */
export interface BuiltGeometry {
  key: string;
  normal: Float32Array;
  position?: Float32Array;
  uv?: Float32Array;
}

export function geometryJob(source: GeometrySource): GeometryJob {
  const key = geometryKey(source);
  return source.kind === 'mesh' ? { key, kind: 'mesh', mesh: source.mesh } : { key, kind: 'hull', hull: source.hull };
}

/** One job per distinct geometry the layout draws. */
export function geometryJobs(layout: SceneLayout): GeometryJob[] {
  const sources = [...layout.batches.map((b) => b.source), ...layout.unique.map((u) => u.source), ...layout.statics.map((s) => s.source)];
  const jobs = new Map<string, GeometryJob>();
  for (const source of sources) jobs.set(geometryKey(source), geometryJob(source));
  return [...jobs.values()];
}

/** The shared mesh files a scene's visuals read, as paths relative to the scene folder. */
export const meshFiles = (visuals: readonly { mesh?: MeshRef }[]) => [...new Set(visuals.flatMap((v) => (v.mesh?.file ? [v.mesh.file] : [])))];

/**
 * The geometry kernels, self-contained (no imports or outer references) so a worker can run them from their source
 * text. Normals match three's BufferGeometry.computeVertexNormals bit for bit: the same double-precision math, with
 * the same float32 rounding between steps, and creased normals match BufferGeometryUtils.toCreasedNormals.
 */
export function geometryKernels() {
  function normalizeInPlace(normals: Float32Array) {
    for (let i = 0; i < normals.length; i += 3) {
      const x = normals[i];
      const y = normals[i + 1];
      const z = normals[i + 2];
      const inverse = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
      normals[i] = x * inverse;
      normals[i + 1] = y * inverse;
      normals[i + 2] = z * inverse;
    }
    return normals;
  }

  /** Face normal (c - b) x (a - b) of the triangle with corners a, b, c, unnormalized, into `out`. */
  function faceNormal(p: Float32Array, a: number, b: number, c: number, out: Float64Array) {
    const cbx = p[c * 3] - p[b * 3];
    const cby = p[c * 3 + 1] - p[b * 3 + 1];
    const cbz = p[c * 3 + 2] - p[b * 3 + 2];
    const abx = p[a * 3] - p[b * 3];
    const aby = p[a * 3 + 1] - p[b * 3 + 1];
    const abz = p[a * 3 + 2] - p[b * 3 + 2];
    out[0] = cby * abz - cbz * aby;
    out[1] = cbz * abx - cbx * abz;
    out[2] = cbx * aby - cby * abx;
  }

  function indexedNormals(positions: Float32Array, index: Uint16Array | Uint32Array) {
    const normals = new Float32Array(positions.length);
    const face = new Float64Array(3);
    const sums = new Float64Array(9);
    for (let i = 0; i < index.length; i += 3) {
      faceNormal(positions, index[i], index[i + 1], index[i + 2], face);
      // All three corners are read before any is written, so a degenerate triangle repeating a vertex adds once.
      for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) sums[k * 3 + d] = normals[index[i + k] * 3 + d] + face[d];
      for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) normals[index[i + k] * 3 + d] = sums[k * 3 + d];
    }
    return normalizeInPlace(normals);
  }

  function flatNormals(positions: Float32Array) {
    const normals = new Float32Array(positions.length);
    const face = new Float64Array(3);
    for (let v = 0; v < positions.length / 3; v += 3) {
      faceNormal(positions, v, v + 1, v + 2, face);
      for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) normals[(v + k) * 3 + d] = face[d];
    }
    return normalizeInPlace(normals);
  }

  /** A hull's faces fanned into triangles, one vertex per corner. */
  function hullPositions(verts: Float32Array, faceStart: Uint32Array, faceVerts: Uint32Array, faceCount: number) {
    let triangles = 0;
    for (let f = 0; f < faceCount; f++) triangles += Math.max(0, faceStart[f + 1] - faceStart[f] - 2);
    const positions = new Float32Array(triangles * 9);
    let out = 0;
    for (let f = 0; f < faceCount; f++) {
      const s = faceStart[f];
      const n = faceStart[f + 1] - s;
      for (let k = 1; k + 1 < n; k++) {
        for (const corner of [faceVerts[s], faceVerts[s + k], faceVerts[s + k + 1]]) {
          positions[out++] = verts[corner * 3];
          positions[out++] = verts[corner * 3 + 1];
          positions[out++] = verts[corner * 3 + 2];
        }
      }
    }
    return positions;
  }

  function meshData({ bin, files }: GeometryFiles, ref: MeshRef): VisualMeshData {
    if (ref.file === undefined) {
      return {
        pos: new Float32Array(bin, ref.v.off, ref.v.n),
        idx: new Uint32Array(bin, ref.i.off, ref.i.n),
        uv: ref.uv ? new Float32Array(bin, ref.uv.off, ref.uv.n) : null,
      };
    }
    const buffer = files.get(ref.file);
    if (!buffer) throw new Error(`mesh file ${ref.file} was not loaded`);
    const indexOffset = ref.nv * 12;
    const wide = ref.index !== 'u16';
    const idx = wide ? new Uint32Array(buffer, indexOffset, ref.ni) : new Uint16Array(buffer, indexOffset, ref.ni);
    const uvOffset = indexOffset + Math.ceil((ref.ni * (wide ? 4 : 2)) / 4) * 4;
    return { pos: new Float32Array(buffer, 0, ref.nv * 3), idx, uv: ref.uv ? new Float32Array(buffer, uvOffset, ref.nv * 2) : null };
  }

  function unindexed(values: Float32Array, index: Uint16Array | Uint32Array, size: number) {
    const out = new Float32Array(index.length * size);
    for (let i = 0; i < index.length; i++) for (let d = 0; d < size; d++) out[i * size + d] = values[index[i] * size + d];
    return out;
  }

  /** Each corner's normal averages the faces around its position within `creaseAngle` of its own face. */
  function creasedNormals(positions: Float32Array, creaseAngle: number) {
    const vertexCount = positions.length / 3;
    const faceCount = vertexCount / 3;
    const creaseDot = Math.cos(creaseAngle);
    const hashMultiplier = (1 + 1e-10) * 1e2;
    const faceNormals = new Float64Array(faceCount * 3);
    const face = new Float64Array(3);
    for (let f = 0; f < faceCount; f++) {
      faceNormal(positions, f * 3, f * 3 + 1, f * 3 + 2, face);
      const inverse = 1 / (Math.sqrt(face[0] * face[0] + face[1] * face[1] + face[2] * face[2]) || 1);
      for (let d = 0; d < 3; d++) faceNormals[f * 3 + d] = face[d] * inverse;
    }
    const vertexIds = new Int32Array(vertexCount);
    const quantized = new Float64Array(vertexCount * 3);
    let tableSize = 1;
    while (tableSize < vertexCount * 2) tableSize <<= 1;
    const table = new Int32Array(tableSize);
    let uniqueCount = 0;
    for (let i = 0; i < vertexCount; i++) {
      const qx = Math.trunc(positions[i * 3] * hashMultiplier);
      const qy = Math.trunc(positions[i * 3 + 1] * hashMultiplier);
      const qz = Math.trunc(positions[i * 3 + 2] * hashMultiplier);
      let slot = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & (tableSize - 1);
      for (;;) {
        const id = table[slot];
        if (id === 0) {
          quantized.set([qx, qy, qz], uniqueCount * 3);
          table[slot] = uniqueCount + 1;
          vertexIds[i] = uniqueCount++;
          break;
        }
        const q = (id - 1) * 3;
        if (quantized[q] === qx && quantized[q + 1] === qy && quantized[q + 2] === qz) {
          vertexIds[i] = id - 1;
          break;
        }
        slot = (slot + 1) & (tableSize - 1);
      }
    }
    const bucketOffsets = new Int32Array(uniqueCount + 1);
    for (let i = 0; i < vertexCount; i++) bucketOffsets[vertexIds[i] + 1]++;
    for (let i = 0; i < uniqueCount; i++) bucketOffsets[i + 1] += bucketOffsets[i];
    const bucketFaces = new Int32Array(vertexCount);
    const cursors = bucketOffsets.slice(0, uniqueCount);
    for (let i = 0; i < vertexCount; i++) bucketFaces[cursors[vertexIds[i]]++] = Math.floor(i / 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      const f = Math.floor(i / 3) * 3;
      const id = vertexIds[i];
      let x = 0;
      let y = 0;
      let z = 0;
      for (let k = bucketOffsets[id]; k < bucketOffsets[id + 1]; k++) {
        const o = bucketFaces[k] * 3;
        if (faceNormals[f] * faceNormals[o] + faceNormals[f + 1] * faceNormals[o + 1] + faceNormals[f + 2] * faceNormals[o + 2] > creaseDot) {
          x += faceNormals[o];
          y += faceNormals[o + 1];
          z += faceNormals[o + 2];
        }
      }
      const inverse = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
      normals[i * 3] = x * inverse;
      normals[i * 3 + 1] = y * inverse;
      normals[i * 3 + 2] = z * inverse;
    }
    return normals;
  }

  function build(bin: ArrayBuffer, job: GeometryJob, mesh: (ref: MeshRef) => VisualMeshData): BuiltGeometry {
    if (job.kind === 'mesh') {
      const { pos, idx, uv } = mesh(job.mesh);
      if (!job.mesh.crease) return { key: job.key, normal: indexedNormals(pos, idx) };
      // Simplified meshes share vertices across hard edges, so their normals split above 30 degrees.
      const position = unindexed(pos, idx, 3);
      return { key: job.key, position, normal: creasedNormals(position, Math.PI / 6), uv: uv ? unindexed(uv, idx, 2) : undefined };
    }
    const f32 = (r: { off: number; n: number }) => new Float32Array(bin, r.off, r.n);
    const u32 = (r: { off: number; n: number }) => new Uint32Array(bin, r.off, r.n);
    const { verts, face_start, face_verts, nf } = job.hull;
    const position = hullPositions(f32(verts), u32(face_start), u32(face_verts), nf);
    return { key: job.key, position, normal: flatNormals(position) };
  }

  return { build, meshData };
}
