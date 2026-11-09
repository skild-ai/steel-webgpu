# steel-webgpu viewer: plain three.js

The full scene viewer on `@skild-ai/steel-webgpu` and `@skild-ai/steel-webgpu-three` alone, with no UI framework: all scenes by category, a
scene picker and gallery, HUD stats, play, pause and reset, drag-to-pull, the compare toggle and solver controls.
`apps/viewer` is the same viewer on `@skild-ai/steel-webgpu-react`.

```bash
bun install
bun run dev    # http://localhost:5301/?demo=bolt_sweep
```

## How it is wired

| File | |
| --- | --- |
| `src/main.ts` | Requests the device (or shows the unsupported message), reads the URL, and connects the HUD, gallery and viewer |
| `src/stage.ts` | `createStudioRenderer` and `applyStudio` for the studio look, the camera, `OrbitControls`, and `DragPull` for the shown world |
| `src/viewer.ts` | One `SteelWorld` at a time: `SteelWorld.load`, `world.update(now)` every frame, `setPlayback`, `rebuild` for solver changes, `requestStats` for the HUD |
| `src/hud.ts` | The panel's DOM: stats, scene picker, buttons, compare toggle, solver controls |
| `src/gallery.ts` | Scene cards with previews from `ScenePreviewer`, and `prefetchScene` on hover |
| `src/query.ts` | The URL flags |

Everything physics- or render-specific comes from `@skild-ai/steel-webgpu-three`: the GPU-placed scene graph, the pose copy
from the Sim, frame pacing, picking and the pull spring. The example only adds the page around it.

## URL flags

| Flag | |
| --- | --- |
| `demo=<name>` | The scene, a folder name from `index.json` |
| `paused` | Start paused |
| `without` | Start with the scene's compare option switched off |
| `ss=`, `it=`, `sleep=0\|1`, `nest=0\|1` | Substeps, iterations, sleeping and momentum |
| `reg=`, `warm=` | Solver regularization and warm start |
| `gallery` | Open the scene gallery |
| `collision` | Draw the convex hulls the solver collides instead of the scene's visuals |

The scenes are served from the repository's `assets/scenes` through the `public/assets` symlink.
