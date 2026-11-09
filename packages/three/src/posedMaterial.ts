import { Color, MeshStandardNodeMaterial, SRGBColorSpace, type Node, type StorageBufferNode, type Texture } from 'three/webgpu';
import { Fn, attribute, batchIndirectIndex, cross, int, materialColor, normalLocal, positionLocal } from 'three/tsl';
import { VEC4_PER_POSE } from './poseBridge';
import type { Vec3 } from '@skild-ai/steel-webgpu';

export const PIECE_OFFSET = 'pieceOffset';
export const PIECE_ROTATION = 'pieceRotation';
export const PIECE_COLOR = 'pieceColor';

export type PoseBuffer = StorageBufferNode<'vec4'>;

export const rotateByQuat = Fn(([q, v]: [Node<'vec4'>, Node<'vec3'>]) => {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
});

export const bodyPose = (poses: PoseBuffer, body: Node<'float'> | Node<'int'>) => {
  const base = int(body).mul(VEC4_PER_POSE);
  return { com: poses.element(base).xyz, quat: poses.element(base.add(1)) };
};

/** Per BatchedMesh instance: offset (xyz, body in w) and rotation, as the instanced attributes hold them. */
export const VEC4_PER_PLACEMENT = 2;

function placePiece(poses: PoseBuffer, offset: Node<'vec4'>, rotation: Node<'vec4'>) {
  const { com, quat } = bodyPose(poses, offset.w);
  normalLocal.assign(rotateByQuat(quat, rotateByQuat(rotation, normalLocal)));
  return com.add(rotateByQuat(quat, offset.xyz.add(rotateByQuat(rotation, positionLocal))));
}

/** Places instanced body pieces from the GPU pose buffer; per instance: pieceOffset (xyz, body in w) and pieceRotation. */
export function posedPiecePosition(poses: PoseBuffer) {
  return Fn(() => placePiece(poses, attribute(PIECE_OFFSET, 'vec4'), attribute(PIECE_ROTATION, 'vec4')))();
}

const placement = (placements: PoseBuffer, field: number) => placements.element(int(batchIndirectIndex).mul(VEC4_PER_PLACEMENT).add(field));

/** Places the pieces of a BatchedMesh from the GPU pose buffer and their `placements`. */
export function batchedPiecePosition(poses: PoseBuffer, placements: PoseBuffer) {
  return Fn(() => placePiece(poses, placement(placements, 0), placement(placements, 1)))();
}

/** The material color times each instance's pieceColor attribute. */
export const instancedPieceColor = materialColor.mul(attribute(PIECE_COLOR, 'vec3'));

export const srgb = (c: Vec3, target = new Color()) => target.setRGB(c[0], c[1], c[2], SRGBColorSpace);

export const bodyMaterial = (color: Vec3, map: Texture | null) => new MeshStandardNodeMaterial({ color: srgb(color), map, roughness: 0.45, metalness: 0 });

/** Share one positionNode across materials: three reuses node builds only for the same node instance. */
export function createPosedMaterial(color: Vec3, map: Texture | null, positionNode: Node<'vec3'>) {
  const material = bodyMaterial(color, map);
  material.positionNode = positionNode;
  return material;
}
