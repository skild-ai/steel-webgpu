# @skild-ai/steel-webgpu

The framework-free engine of [steel-webgpu](https://github.com/skild-ai/steel-webgpu): a WebGPU port of Newton's
`SolverSteel` (FeatherPGS articulated contact solver). It runs scenes built with `SceneBuilder`, imported from URDF,
MJCF or USDA, or exported from Newton, with Newton's `State` and `Control` indices.

## Install

```bash
bun add @skild-ai/steel-webgpu
```

With npm or pnpm, use `npm install` or `pnpm add` in place of `bun add`.
TypeScript projects also need [`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types) in `compilerOptions.types`
for the `GPUDevice` and `GPUBuffer` types in the public API.

## Usage

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

To draw a scene, use [`@skild-ai/steel-webgpu-three`](https://github.com/skild-ai/steel-webgpu/tree/main/packages/three) or
[`@skild-ai/steel-webgpu-react`](https://github.com/skild-ai/steel-webgpu/tree/main/packages/react).
## Importing robots

Meshes collide as convex hulls; STL and OBJ load.

```ts
import { loadMJCF, loadURDF, loadUSDA } from '@skild-ai/steel-webgpu';

await loadURDF(b, urdfText, { baseUrl: urdfUrl, xform: [0, 0, 0.5, 0, 0, 0, 1] });
await loadMJCF(b, mjcfText, { baseUrl: mjcfUrl });
loadUSDA(b, usdaText); // text USD with UsdPhysics bodies, colliders, mass, joints and drives
```

## License

Apache-2.0; see [LICENSE.md](LICENSE.md).
