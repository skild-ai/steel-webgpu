import type { LoadedScene, Transform, Vec3 } from './sceneTypes';

export type Vec = ArrayLike<number>;

/** Newton's shape settings; every field is optional. */
export interface ShapeOptions {
  xform?: Transform;
  density?: number;
  mu?: number;
  restitution?: number;
  muTorsional?: number;
  muRolling?: number;
  gap?: number;
  ke?: number;
  kd?: number;
  collisionGroup?: number;
  world?: number;
  color?: Vec3;
}

/** Newton's JointDofConfig. */
export interface DofOptions {
  limitLower?: number;
  limitUpper?: number;
  targetPos?: number;
  targetVel?: number;
  targetKe?: number;
  targetKd?: number;
  damping?: number;
  armature?: number;
  effortLimit?: number;
  velocityLimit?: number;
  friction?: number;
}

export interface JointOptions extends DofOptions {
  parentXform?: Transform;
  childXform?: Transform;
  q?: number | number[];
  label?: string;
  collisionFilterParent?: boolean;
}

export interface BodyOptions {
  xform?: Transform;
  mass?: number;
  com?: Vec3;
  /** 3x3 row-major, about the COM. */
  inertia?: number[];
  label?: string;
  kinematic?: boolean;
  gravity?: boolean;
  twist?: [number, number, number, number, number, number];
}

export type D6Axis = Vec3 | ({ axis: Vec3 } & DofOptions);

/** Builds a scene in code, the way Newton's ModelBuilder does; `finalize()` returns a scene for `Sim`. */
export declare class SceneBuilder {
  constructor(options?: { gravity?: Vec3; fps?: number });
  addBody(options?: BodyOptions): number;
  addShape(body: number, type: number, size: Vec3, options?: ShapeOptions, hullPoints?: number[][] | null): number;
  addShapeBox(body: number, options?: { hx?: number; hy?: number; hz?: number } & ShapeOptions): number;
  addShapeSphere(body: number, options?: { radius?: number } & ShapeOptions): number;
  addShapeCapsule(body: number, options?: { radius?: number; halfHeight?: number } & ShapeOptions): number;
  addShapeCylinder(body: number, options?: { radius?: number; halfHeight?: number } & ShapeOptions): number;
  addShapeConvexHull(body: number, options: { vertices: number[][] | Vec } & ShapeOptions): number;
  addGroundPlane(options?: { height?: number } & ShapeOptions): number;
  addVisualMesh(body: number, options: { vertices: Vec | number[][]; indices: Vec; xform?: Transform; color?: Vec3 }): void;
  addCollisionFilter(shapeA: number, shapeB: number): void;
  addJoint(type: number, parent: number, child: number, options?: JointOptions & { axes?: Vec3[]; linear?: number; dofs?: DofOptions[] }): number;
  addJointRevolute(parent: number, child: number, options?: { axis?: Vec3 } & JointOptions): number;
  addJointPrismatic(parent: number, child: number, options?: { axis?: Vec3 } & JointOptions): number;
  addJointBall(parent: number, child: number, options?: JointOptions): number;
  addJointFixed(parent: number, child: number, options?: JointOptions): number;
  addJointD6(parent: number, child: number, options?: { linearAxes?: D6Axis[]; angularAxes?: D6Axis[] } & JointOptions): number;
  addJointFree(child: number, options?: JointOptions): number;
  setJointDofConfig(joint: number, axisIndex: number, config: DofOptions): void;
  setJointMimic(joint: number, reference: number | null, coeffs?: [number, number]): void;
  /** Newton dof index of a joint's first dof, valid after `finalize()`. */
  jointDof(joint: number): number;
  finalize(options?: { solver?: Record<string, unknown> }): LoadedScene;
}

export declare function convexHull(points: number[][]): unknown;
