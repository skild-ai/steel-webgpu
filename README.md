# steel-webgpu

A WebGPU port of the Steel solver from [Newton](https://github.com/newton-physics/newton), running in the browser.

## Requirements

A browser with WebGPU: Chrome, Edge or Safari, on desktop or mobile.

## Packages

| Package | |
| --- | --- |
| [`@skild-ai/steel-webgpu`](packages/core) | The engine: `Sim`, `SceneBuilder`, scene loading, URDF, MJCF and USDA import |
| [`@skild-ai/steel-webgpu-three`](packages/three) | three.js rendering, picking and drag |
| [`@skild-ai/steel-webgpu-react`](packages/react) | React Three Fiber components and hooks |

## Install

```bash
# The engine alone
bun add @skild-ai/steel-webgpu

# With three.js
bun add @skild-ai/steel-webgpu-three @skild-ai/steel-webgpu three typegpu

# With React Three Fiber
bun add @skild-ai/steel-webgpu-react three typegpu @react-three/fiber react react-dom
```

With npm or pnpm, use `npm install` or `pnpm add` in place of `bun add`. Each package's README has a quick start.
Newton models export to a scene folder with `tools/newton_export.py`.

## Development

Needs [Bun](https://bun.sh).

```bash
bun install
bunx vp check       # format and lint
bunx vp test        # unit tests
bun run typecheck
bun run build
bun changeset       # describe a change to the published packages
cd apps/viewer && bun run dev   # the scene viewer on http://localhost:5199/?demo=bolt_sweep
```

## License

Apache-2.0. The bundled robot models keep their own BSD-3-Clause and MIT licenses; see [LICENSE.md](LICENSE.md).
