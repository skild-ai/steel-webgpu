# steel-webgpu

The framework-free engine of [steel-webgpu](https://github.com/skild-ai/steel-webgpu): a WebGPU port of Newton's
`SolverSteel` (FeatherPGS articulated contact solver). It runs scenes built with `SceneBuilder`, imported from URDF,
MJCF or USDA, or exported from Newton, with Newton's `State` and `Control` indices.

## Install

```bash
bun add steel-webgpu
```

## Usage

```ts
import { SceneBuilder, Sim, UnsupportedError, initDevice, loadScene } from 'steel-webgpu';

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

`steel-webgpu/device` holds the viewer helpers (`metric`, `binCount` and the query-flag readers).

To draw a scene, use [`@steel-webgpu/three`](https://github.com/skild-ai/steel-webgpu/tree/main/packages/three) or
[`@steel-webgpu/react`](https://github.com/skild-ai/steel-webgpu/tree/main/packages/react).
See the [main README](https://github.com/skild-ai/steel-webgpu#readme) for the API table, loaders, browser
requirements and what is not ported.

## License

Apache-2.0, with a BSD-3-Clause robot model; see [LICENSE.md](LICENSE.md).
