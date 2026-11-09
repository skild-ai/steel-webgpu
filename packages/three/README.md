# @steel-webgpu/three

The three.js WebGPU binding of [steel-webgpu](https://github.com/skild-ai/steel-webgpu). `SteelWorld` pairs a `Sim`
with a scene graph whose instanced materials read the solver's pose buffer, copied GPU to GPU each frame, so
rendering needs no readback. It also has the studio look (sky, fog, lights, shadows), picking and mouse drag
(`DragPull`), and a frame pacer.

## Install

```bash
bun add @steel-webgpu/three steel-webgpu three
```

`three` 0.187 or newer is a peer dependency.

## Usage

```ts
import { applyStudio, createStudioRenderer, sceneCamera, SteelWorld } from '@steel-webgpu/three';
import { initDevice } from 'steel-webgpu';
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
[examples/vanilla-three](https://github.com/skild-ai/steel-webgpu/tree/main/examples/vanilla-three); see the
[main README](https://github.com/skild-ai/steel-webgpu#readme) for the rest.

## License

Apache-2.0; see [LICENSE.md](LICENSE.md).
