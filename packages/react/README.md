# @steel-webgpu/react

React Three Fiber bindings for [steel-webgpu](https://github.com/skild-ai/steel-webgpu). `<Physics>` owns the
WebGPU device and an R3F canvas on it; `<Scene>` loads a scene folder or builds one from declarative bodies, joints
and robots; hooks run code around every physics step.

## Install

```bash
bun add @steel-webgpu/react three @react-three/fiber react react-dom
```

`three` 0.187+, `react` 19+ and `@react-three/fiber` 9.8+ are peer dependencies.

## Usage

```tsx
import { BoxCollider, Ground, Physics, RevoluteJoint, RigidBody, Scene, SphereCollider, useSimStats } from '@steel-webgpu/react';

export const Folder = () => (
  <Physics unsupported={(reason) => <p>This browser cannot run steel-webgpu: {reason}</p>}>
    <Scene src="/assets/bolt_sweep" />
  </Physics>
);

export const Declarative = () => (
  <Physics>
    <Scene>
      <Ground />
      <RigidBody name="crate" position={[0, 0, 0.5]}>
        <BoxCollider hx={0.05} hy={0.05} hz={0.05} />
      </RigidBody>
      <RigidBody name="bob" position={[0.2, 0, 0.3]}>
        <SphereCollider radius={0.05} />
        <RevoluteJoint parent={null} axis={[0, 1, 0]} parentFrame={[0.2, 0, 0.6, 0, 0, 0, 1]} childFrame={[0, 0, 0.3, 0, 0, 0, 1]} q={1} />
      </RigidBody>
    </Scene>
  </Physics>
);
```

| | |
| --- | --- |
| `<Physics unsupported fallback studio>` | Device and canvas; takes R3F `Canvas` props |
| `<Scene src options paused suspended collision controls pickable camera frameCamera onLoaded ref>` | One simulated scene; without `src` it builds from its children |
| `<RigidBody name position quaternion mass kinematic ref>` | A body; its handle has `pose`, `setPose`, `setTwist`, `applyWrench` |
| `<BoxCollider>`, `<SphereCollider>`, `<CapsuleCollider>`, `<CylinderCollider>`, `<ConvexHullCollider>`, `<Ground>` | Shapes, as children of a body |
| `<RevoluteJoint>`, `<PrismaticJoint>`, `<BallJoint>`, `<FixedJoint>`, `<D6Joint>` | Joints, as children of the child body, naming the `parent` body |
| `<URDF src ref>`, `<MJCF src ref>` | Robots; the handle drives joints by name with `setJointTarget(joint, pos, vel?)` |
| `usePolicy((state, ctrl) => ...)` | Runs before every step with the latest pose snapshot |
| `useBeforeStep(sim => ...)`, `useAfterStep(sim => ...)` | Run around every step |
| `useSimStats({ hz })` | Solver stats sampled `hz` times a second |
| `useWorld()`, `useDevice()` | The current `SteelWorld` and the `GPUDevice` |

### Camera

`camera={{ position: [x, y, z], target: [x, y, z], fov }}` shows the scene from that viewpoint instead of its own, for
`src` and declarative scenes alike. Coordinates are the scene's world frame (Z up, meters), `fov` is the vertical field
of view in degrees and is optional. Orbit controls pivot around `target`, and changing the prop moves the camera
again. `frameCamera={false}` leaves the camera where it is. The scene ref reads the current view back, e.g. to copy a
viewpoint you orbited to:

```tsx
export function Framed() {
  const scene = useRef<SceneHandle>(null);
  return (
    <>
      <Physics>
        <Scene src="/assets/wrecking_ball" camera={{ position: [2.4, -3.1, 1.6], target: [0, 0, 0.8], fov: 35 }} ref={scene} />
      </Physics>
      <button onClick={() => console.log(scene.current?.getCamera())}>Log camera</button>
    </>
  );
}
```

Hooks go inside `<Scene>`. The [React + Vite](https://github.com/skild-ai/steel-webgpu/tree/main/examples/react-vite)
and [Next.js](https://github.com/skild-ai/steel-webgpu/tree/main/examples/nextjs) examples show complete apps; see
the [main README](https://github.com/skild-ai/steel-webgpu#readme) for the rest.

## License

Apache-2.0; see [LICENSE.md](LICENSE.md).
