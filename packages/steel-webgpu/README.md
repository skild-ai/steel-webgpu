# @skild-ai/steel-webgpu

A WebGPU port of Newton's `SolverSteel` (FeatherPGS articulated contact solver) for the browser. It runs scenes built
with `SceneBuilder`, imported from URDF, MJCF or USDA, or exported from Newton, with Newton's `State` and `Control`
indices.

One package, three entry points. Each one only loads what it imports, so a plain TypeScript or JavaScript app never
pulls in three.js or React.

| Import | What it is | Needs |
| --- | --- | --- |
| `@skild-ai/steel-webgpu` | The framework-free engine: `Sim`, `SceneBuilder`, scene loading, URDF, MJCF and USDA import | nothing |
| `@skild-ai/steel-webgpu/three` | three.js WebGPU rendering: GPU-placed scene graph, studio look, picking and drag | `three` 0.187+, `typegpu` 0.12 |
| `@skild-ai/steel-webgpu/react` | React Three Fiber components and hooks | the above, `react` 19, `@react-three/fiber` 9.8+ |

## Install

```bash
# The engine alone
bun add @skild-ai/steel-webgpu

# With three.js
bun add @skild-ai/steel-webgpu three typegpu

# With React Three Fiber
bun add @skild-ai/steel-webgpu three typegpu @react-three/fiber react react-dom
```

With npm or pnpm, use `npm install` or `pnpm add` in place of `bun add`. The libraries in the third column are optional
peer dependencies: install the ones for the entry points you import.
TypeScript 6 and newer include the WebGPU types the public API uses (`GPUDevice`, `GPUBuffer`). On TypeScript 5, add
[`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types) to `compilerOptions.types`.

## Engine

```ts
import { SceneBuilder, Sim, UnsupportedError, initDevice, loadScene } from '@skild-ai/steel-webgpu';

const b = new SceneBuilder();
b.addGroundPlane();
const box = b.addBody({ xform: [0, 0, 0.5, 0, 0, 0, 1] });
b.addShapeBox(box, { hx: 0.05, hy: 0.05, hz: 0.05 });

try {
  const sim = await Sim.create(await initDevice(), b.finalize()); // or await loadScene('/assets/bolt_sweep')
  sim.step(60);
  const { bodyQ } = await sim.state();
} catch (error) {
  if (error instanceof UnsupportedError) console.warn(error.message); // no WebGPU or adapter
}
```

`@skild-ai/steel-webgpu/device` holds the viewer helpers (`metric`, `binCount` and the query-flag readers).

### Importing robots

Meshes collide as convex hulls; STL and OBJ load.

```ts
import { loadMJCF, loadURDF, loadUSDA } from '@skild-ai/steel-webgpu';

await loadURDF(b, urdfText, { baseUrl: urdfUrl, xform: [0, 0, 0.5, 0, 0, 0, 1] });
await loadMJCF(b, mjcfText, { baseUrl: mjcfUrl });
loadUSDA(b, usdaText); // text USD with UsdPhysics bodies, colliders, mass, joints and drives
```

## three.js

`SteelWorld` pairs a `Sim` with a scene graph whose instanced materials read the solver's pose buffer, copied GPU to
GPU each frame, so rendering needs no readback. It also has the studio look (sky, fog, lights, shadows), picking and
mouse drag (`DragPull`), and a frame pacer.

```ts
import { applyStudio, createStudioRenderer, sceneCamera, SteelWorld } from '@skild-ai/steel-webgpu/three';
import { initDevice } from '@skild-ai/steel-webgpu';
import { PerspectiveCamera, Scene } from 'three/webgpu';

const renderer = await createStudioRenderer({ canvas, device: await initDevice() });
const scene = applyStudio(new Scene());
const world = await SteelWorld.load(renderer, '/assets/bolt_sweep');
scene.add(world.root);

const camera = new PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 1000);
camera.up.set(0, 0, 1);
const { eye, target } = sceneCamera(world.scene);
camera.position.set(...eye);
camera.lookAt(...target);

renderer.setAnimationLoop(() => {
  world.update(performance.now());
  renderer.render(scene, camera);
});
```

`SteelWorld.load(renderer, src, { camera: { position, target, fov } })` replaces the scene's own viewpoint, which
`world.view` returns resolved; `applyCameraView(camera, world.view)` places a camera there and
`readCameraView(camera, target)` reads one back. `world.beforeStep` and `world.afterStep` take callbacks run around every physics step; `world.setCollisionView(true)`
draws the convex hulls the solver collides, one flat tint per body, instead of the visuals; `world.dispose()` releases
the Sim and its GPU resources. A complete page with orbit controls and the unsupported message is in
[examples/vanilla-three](https://github.com/skild-ai/steel-webgpu/tree/main/examples/vanilla-three).

## React Three Fiber

`<Physics>` owns the WebGPU device and an R3F canvas on it; `<Scene>` loads a scene folder or builds one from
declarative bodies, joints and robots; hooks run code around every physics step.

```tsx
import { BoxCollider, Ground, Physics, RevoluteJoint, RigidBody, Scene, SphereCollider, useSimStats } from '@skild-ai/steel-webgpu/react';

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

#### Camera

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
and [Next.js](https://github.com/skild-ai/steel-webgpu/tree/main/examples/nextjs) examples show complete apps.

## License

Apache-2.0; see [LICENSE.md](LICENSE.md).
