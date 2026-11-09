# steel-webgpu

A WebGPU port of the Steel solver from [Newton](https://github.com/newton-physics/newton), running in the browser.

## Requirements

A browser with WebGPU: Chrome, Edge or Safari, on desktop or mobile.

## Packages

| Package | |
| --- | --- |
| [`steel-webgpu`](packages/core) | The engine: `Sim`, `SceneBuilder`, scene loading, URDF, MJCF and USDA import |
| [`@steel-webgpu/three`](packages/three) | three.js rendering, picking and drag |
| [`@steel-webgpu/react`](packages/react) | React Three Fiber components and hooks |

Each package's README shows its install and usage. Newton models export to a scene folder with `tools/newton_export.py`.

## Development

Needs [Bun](https://bun.sh).

```bash
bun install
bunx vp check       # format and lint
bunx vp test        # unit tests
bun run typecheck
bun run build
cd apps/viewer && bun run dev   # the scene viewer on http://localhost:5199/?demo=bolt_sweep
```

## License

Apache-2.0, with a BSD-3-Clause robot model; see [LICENSE.md](LICENSE.md).
