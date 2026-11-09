import type { HullRef, MeshRef, Quat, SceneJson, Transform, Vec3 } from '../index';

export type GeometrySource = { kind: 'mesh'; mesh: MeshRef } | { kind: 'hull'; hull: HullRef };

/** One piece of a body: its geometry drawn at `offset` from the body COM, rotated by `rotation`, in the body frame. */
export interface BodyPiece {
  body: number;
  offset: Vec3;
  rotation: Quat;
  color: Vec3;
}

/** Pieces sharing a geometry and texture, drawn as one instanced mesh with a color per piece. */
export interface PieceBatch {
  key: string;
  source: GeometrySource;
  texture?: string;
  pieces: BodyPiece[];
}

/** An untextured piece whose geometry no other piece shares. */
export interface UniquePiece {
  source: GeometrySource;
  piece: BodyPiece;
}

export interface StaticPiece {
  source: GeometrySource;
  color: Vec3;
  texture?: string;
  xf: Transform;
}

export interface SceneLayout {
  batches: PieceBatch[];
  unique: UniquePiece[];
  statics: StaticPiece[];
  planes: Transform[];
}

export const geometryKey = (source: GeometrySource) =>
  source.kind === 'hull' ? `h${source.hull.verts.off}` : source.mesh.file === undefined ? `m${source.mesh.v.off}` : source.mesh.file;

interface Placed {
  source: GeometrySource;
  color: Vec3;
  body: number;
  xf: Transform;
}

/**
 * Splits a scene into what a viewer draws: visuals, visible collision hulls, and planes; anything not on
 * a body is static. Body pieces sharing a geometry become instanced batches, whatever their colors; the rest are unique
 * pieces, drawn together as one batch. Textured pieces stay instanced, since each texture needs its own material.
 */
export function layoutScene(scene: SceneJson): SceneLayout {
  const placed: Placed[] = [];
  const planes: Transform[] = [];
  const bodiesWithVisuals = new Set(scene.visuals.map((v) => v.body));
  for (const visual of scene.visuals) {
    const source: GeometrySource = visual.hull ? { kind: 'hull', hull: visual.hull } : { kind: 'mesh', mesh: visual.mesh! };
    placed.push({ source, color: visual.color, body: visual.body, xf: visual.xf });
  }
  for (const shape of scene.shapes) {
    if (shape.plane) planes.push(shape.xf);
    if (!shape.hull) continue;
    // Newton marks the shapes it draws; older exports lack the flag, so shapes under visuals stay hidden.
    const hidden = shape.visible === false || (shape.visible === undefined && shape.body >= 0 && bodiesWithVisuals.has(shape.body));
    if (!hidden) placed.push({ source: { kind: 'hull', hull: shape.hull }, color: shape.color, body: shape.body, xf: shape.xf });
  }
  return { ...batchPieces(scene, placed), planes };
}

// Static geometry grey; bodies spread around the hue circle by the golden ratio.
const STATIC_TINT: Vec3 = [0.62, 0.64, 0.68];
function bodyTint(body: number): Vec3 {
  const h = (body * 0.618034) % 1;
  const s = 0.55;
  const l = 0.58;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

/** The collision view: every convex hull the solver collides, one flat tint per body, planes left to the scene. */
export function collisionLayout(scene: SceneJson): SceneLayout {
  const placed = scene.shapes.flatMap((shape): Placed[] =>
    shape.hull
      ? [{ source: { kind: 'hull', hull: shape.hull }, color: shape.body < 0 ? STATIC_TINT : bodyTint(shape.body), body: shape.body, xf: shape.xf }]
      : [],
  );
  return { ...batchPieces(scene, placed), planes: [] };
}

function batchPieces(scene: SceneJson, placed: Placed[]): Omit<SceneLayout, 'planes'> {
  const batches = new Map<string, PieceBatch>();
  const statics: StaticPiece[] = [];

  const addPiece = (source: GeometrySource, color: Vec3, body: number, xf: Transform) => {
    const texture = source.kind === 'mesh' ? source.mesh.texture : undefined;
    const key = `${geometryKey(source)}|${texture ?? ''}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { key, source, texture, pieces: [] };
      batches.set(key, batch);
    }
    const com = scene.bodies.com[body];
    batch.pieces.push({
      body,
      offset: [xf[0] - com[0], xf[1] - com[1], xf[2] - com[2]],
      rotation: [xf[3], xf[4], xf[5], xf[6]],
      color,
    });
  };
  for (const { source, color, body, xf } of placed) {
    if (body < 0) statics.push({ source, color, xf, texture: source.kind === 'mesh' ? source.mesh.texture : undefined });
    else addPiece(source, color, body, xf);
  }
  const instanced = (b: PieceBatch) => b.pieces.length > 1 || b.texture !== undefined;
  const all = [...batches.values()];
  const unique = all.filter((b) => !instanced(b)).map((b) => ({ source: b.source, piece: b.pieces[0] }));
  return { batches: all.filter(instanced), unique, statics };
}
