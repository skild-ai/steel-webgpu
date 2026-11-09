import { useContext, useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from 'react';
import type { BodyOptions, D6Axis, DofOptions, JointOptions, Quat, SceneBuilder, ShapeOptions, Transform, Vec3 } from '../index';
import { Quaternion, Vector3 } from 'three/webgpu';
import { BodyContext, BuildContext, useWorld, type BodySlot, type BuildOp } from './context';

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

function useBuildOp(make: () => BuildOp, key: string) {
  const registry = useContext(BuildContext);
  if (!registry) throw new Error('Declarative bodies, joints and robots must be inside a <Scene> without src');
  const createOp = useEffectEvent(make);
  useEffect(() => registry.register(createOp()), [registry, key]);
}

function useBody(component: string) {
  const body = useContext(BodyContext);
  if (!body) throw new Error(`<${component}> must be inside a <RigidBody>`);
  return body;
}

const transform = (position: Vec3 = [0, 0, 0], quaternion: Quat = IDENTITY_QUAT): Transform => [...position, ...quaternion];

/** A body's COM position and orientation, updated in place from the shared pose readback. */
export interface BodyPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

export interface RigidBodyHandle {
  /** The body's index in the Sim; -1 until the scene is built. */
  readonly index: number;
  /** A reused snapshot; reading it keeps a pooled readback running each stepped frame. */
  readonly pose: BodyPose;
  setPose(com: Vec3, quaternion: Quat): void;
  setTwist(twist: [number, number, number, number, number, number]): void;
  applyWrench(force: Vec3, torque: Vec3): void;
}

export interface RigidBodyProps extends Omit<BodyOptions, 'xform' | 'label'> {
  /** Unique within the scene; joints name their parent body with it. */
  name: string;
  position?: Vec3;
  quaternion?: Quat;
  ref?: Ref<RigidBodyHandle>;
  children?: ReactNode;
}

export function RigidBody({ name, position, quaternion, ref, children, ...body }: RigidBodyProps) {
  const slot = useMemo<BodySlot>(() => ({ name, index: -1 }), [name]);
  useBuildOp(
    () => ({
      phase: 0,
      run(builder, names) {
        slot.index = builder.addBody({ ...body, label: name, xform: transform(position, quaternion) });
        names.set(name, slot.index);
      },
    }),
    JSON.stringify([name, position, quaternion, body]),
  );
  const world = useWorld();
  const pose = useMemo<BodyPose>(() => ({ position: new Vector3(), quaternion: new Quaternion() }), []);
  const unsubscribe = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      unsubscribe.current?.();
      unsubscribe.current = null;
    },
    [world],
  );
  useImperativeHandle(
    ref,
    () => ({
      get index() {
        return slot.index;
      },
      get pose() {
        if (world && !unsubscribe.current) unsubscribe.current = world.subscribePoses();
        const poses = world?.poses();
        if (poses && slot.index >= 0) {
          const o = slot.index * 8;
          pose.position.set(poses[o], poses[o + 1], poses[o + 2]);
          pose.quaternion.set(poses[o + 4], poses[o + 5], poses[o + 6], poses[o + 7]);
        }
        return pose;
      },
      setPose: (com, q) => world?.sim.setBodyPose(slot.index, com, q),
      setTwist: (twist) => world?.sim.setBodyTwist(slot.index, twist),
      applyWrench: (force, torque) => world?.sim.setBodyWrench(slot.index, force, torque),
    }),
    [world, slot, pose],
  );
  return <BodyContext.Provider value={slot}>{children}</BodyContext.Provider>;
}

interface ColliderPose {
  position?: Vec3;
  quaternion?: Quat;
}

type ColliderProps<Size> = Size & ColliderPose & Omit<ShapeOptions, 'xform'>;

function useCollider(component: string, add: (builder: SceneBuilder, body: number, options: ShapeOptions) => void, props: ColliderPose & ShapeOptions) {
  const body = useBody(component);
  const { position, quaternion, ...options } = props;
  useBuildOp(
    () => ({ phase: 1, run: (builder) => add(builder, body.index, { ...options, xform: transform(position, quaternion) }) }),
    JSON.stringify([component, body.name, props]),
  );
  return null;
}

export const BoxCollider = ({ hx, hy, hz, ...p }: ColliderProps<{ hx?: number; hy?: number; hz?: number }>) =>
  useCollider('BoxCollider', (b, body, o) => b.addShapeBox(body, { hx, hy, hz, ...o }), p);

export const SphereCollider = ({ radius, ...p }: ColliderProps<{ radius?: number }>) =>
  useCollider('SphereCollider', (b, body, o) => b.addShapeSphere(body, { radius, ...o }), p);

/** Axis along the shape's z. */
export const CapsuleCollider = ({ radius, halfHeight, ...p }: ColliderProps<{ radius?: number; halfHeight?: number }>) =>
  useCollider('CapsuleCollider', (b, body, o) => b.addShapeCapsule(body, { radius, halfHeight, ...o }), p);

/** Axis along the shape's z. */
export const CylinderCollider = ({ radius, halfHeight, ...p }: ColliderProps<{ radius?: number; halfHeight?: number }>) =>
  useCollider('CylinderCollider', (b, body, o) => b.addShapeCylinder(body, { radius, halfHeight, ...o }), p);

export const ConvexHullCollider = ({ vertices, ...p }: ColliderProps<{ vertices: number[][] }>) =>
  useCollider('ConvexHullCollider', (b, body, o) => b.addShapeConvexHull(body, { vertices, ...o }), p);

/** A static infinite plane facing +z. */
export function Ground({ height = 0, ...options }: { height?: number } & Omit<ShapeOptions, 'xform'>) {
  useBuildOp(() => ({ phase: 0, run: (builder) => void builder.addGroundPlane({ height, ...options }) }), JSON.stringify([height, options]));
  return null;
}

interface JointProps extends Omit<JointOptions, 'parentXform' | 'childXform'> {
  /** The parent body's name, or null for the world. */
  parent: string | null;
  /** Joint frame in the parent body, and in this body. */
  parentFrame?: Transform;
  childFrame?: Transform;
}

function useJoint(component: string, add: (builder: SceneBuilder, parent: number, child: number, options: JointOptions) => void, props: JointProps) {
  const body = useBody(component);
  const { parent, parentFrame, childFrame, ...options } = props;
  useBuildOp(
    () => ({
      phase: 2,
      joint: { child: body.name, parent },
      run(builder, names) {
        const parentIndex = parent === null ? -1 : names.get(parent);
        if (parentIndex === undefined) throw new Error(`<${component}> on ${body.name}: no body named ${parent}`);
        add(builder, parentIndex, body.index, { ...options, parentXform: parentFrame, childXform: childFrame });
      },
    }),
    JSON.stringify([component, body.name, props]),
  );
  return null;
}

export const RevoluteJoint = ({ axis, ...p }: JointProps & { axis?: Vec3 }) =>
  useJoint('RevoluteJoint', (b, parent, child, o) => b.addJointRevolute(parent, child, { axis, ...o }), p);

export const PrismaticJoint = ({ axis, ...p }: JointProps & { axis?: Vec3 }) =>
  useJoint('PrismaticJoint', (b, parent, child, o) => b.addJointPrismatic(parent, child, { axis, ...o }), p);

export const BallJoint = (p: JointProps) => useJoint('BallJoint', (b, parent, child, o) => b.addJointBall(parent, child, o), p);

export const FixedJoint = (p: JointProps) => useJoint('FixedJoint', (b, parent, child, o) => b.addJointFixed(parent, child, o), p);

export const D6Joint = ({ linearAxes, angularAxes, ...p }: JointProps & { linearAxes?: D6Axis[]; angularAxes?: D6Axis[] } & DofOptions) =>
  useJoint('D6Joint', (b, parent, child, o) => b.addJointD6(parent, child, { linearAxes, angularAxes, ...o }), p);
