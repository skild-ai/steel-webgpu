import { R3F_URL, launch, openPage } from './browser';

/**
 * Steps a scene's simulation against a controller, frame by frame: it reports the pose of the scene's first body and
 * applies the joint targets the controller answers with. `tools/hand_stairs.py` serves such a controller and bakes the
 * targets it sent into the scene.
 *
 * Needs the viewer's dev server, which resolves the engine by name: `bun run dev`, then `bun scripts/drive.ts [url]`.
 */
const controller = process.argv[2] ?? 'http://127.0.0.1:8791';
const ENGINE = '/@id/@skild-ai/steel-webgpu';

interface DriveConfig {
  /** Scene folder name. */
  scene: string;
  frames: number;
  /** Newton dof the first target drives; the rest follow it in order. */
  dof: number;
}

const problems: string[] = [];
const browser = await launch();
const page = await openPage(browser, `${R3F_URL}?paused`, problems);
const result = await page.evaluate(
  async ({ controller, engine }) => {
    const { Sim, initDevice, loadScene } = (await import(/* @vite-ignore */ engine)) as typeof import('@skild-ai/steel-webgpu');
    const config: DriveConfig = await fetch(`${controller}/config`).then((r) => r.json());
    const sim = await Sim.create(await initDevice(), await loadScene(`/assets/${config.scene}`));
    const started = performance.now();
    for (let frame = 0; frame < config.frames; frame++) {
      // Body 0: center of mass, then quaternion x, y, z, w.
      const p = await sim.poses();
      const reply = await fetch(`${controller}/step`, { method: 'POST', body: JSON.stringify({ frame, palm: [p[0], p[1], p[2], p[4], p[5], p[6], p[7]] }) });
      if (!reply.ok) throw new Error(`${controller} answered ${reply.status} at frame ${frame}`);
      const { targets }: { targets: number[] } = await reply.json();
      sim.setJointTargets(targets, null, config.dof);
      sim.step(1);
    }
    const end = await sim.poses();
    sim.destroy();
    return { ...config, seconds: (performance.now() - started) / 1000, position: Array.from(end.subarray(0, 3)) };
  },
  { controller, engine: ENGINE },
);
await browser.close();

console.log(
  `${result.scene}: ${result.frames} frames in ${result.seconds.toFixed(1)} s, first body ends at ${result.position.map((v) => v.toFixed(3)).join(', ')}`,
);
for (const problem of problems) console.log(problem);
