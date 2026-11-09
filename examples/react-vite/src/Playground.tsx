import { BoxCollider, CapsuleCollider, Ground, RevoluteJoint, RigidBody, SphereCollider, useBeforeStep, type RigidBodyHandle } from '@steel-webgpu/react';
import { useRef } from 'react';
import type { Quat, Vec3 } from 'steel-webgpu';

const PIVOT: Vec3 = [0.1, 0.35, 0.55];
const ARM_HALF_LENGTH = 0.15;
const PADDLE_CENTER: Vec3 = [0.25, -0.25, 0.04];
const PADDLE_SPEED = 1.2;
const CRATE_HALF = 0.05;
const CRATE_COLORS: Vec3[] = [
  [0.85, 0.55, 0.2],
  [0.95, 0.75, 0.3],
  [0.85, 0.55, 0.2],
];

const aboutZ = (angle: number): Quat => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];

export function Playground() {
  const paddle = useRef<RigidBodyHandle>(null);

  useBeforeStep((sim) => paddle.current?.setPose(PADDLE_CENTER, aboutZ(sim.time * PADDLE_SPEED)));

  return (
    <>
      <Ground />
      {CRATE_COLORS.map((color, level) => (
        <RigidBody key={level} name={`crate${level}`} position={[-0.25, -0.05, CRATE_HALF + level * 2.02 * CRATE_HALF]}>
          <BoxCollider hx={CRATE_HALF} hy={CRATE_HALF} hz={CRATE_HALF} color={color} />
        </RigidBody>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <RigidBody key={i} name={`ball${i}`} position={[0.15 + i * 0.06, -0.25, 0.3 + i * 0.1]}>
          <SphereCollider radius={0.03} restitution={0.4} color={[0.2, 0.55, 0.85]} />
        </RigidBody>
      ))}
      <RigidBody ref={paddle} name="paddle" kinematic position={PADDLE_CENTER}>
        <BoxCollider hx={0.15} hy={0.012} hz={0.04} color={[0.3, 0.32, 0.35]} />
      </RigidBody>
      <RigidBody name="pendulum" position={[PIVOT[0], PIVOT[1], PIVOT[2] - ARM_HALF_LENGTH]}>
        <CapsuleCollider radius={0.012} halfHeight={ARM_HALF_LENGTH} color={[0.75, 0.75, 0.78]} />
        <SphereCollider radius={0.05} position={[0, 0, -ARM_HALF_LENGTH]} color={[0.8, 0.25, 0.25]} />
        <RevoluteJoint parent={null} axis={[0, 1, 0]} parentFrame={[...PIVOT, 0, 0, 0, 1]} childFrame={[0, 0, ARM_HALF_LENGTH, 0, 0, 0, 1]} q={1.2} />
      </RigidBody>
    </>
  );
}
