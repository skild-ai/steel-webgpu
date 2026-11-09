import { ACESFilmicToneMapping, PCFShadowMap, PerspectiveCamera, Quaternion, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import { loadScene } from 'steel-webgpu';
import { SceneGraph } from './sceneGraph';
import type { LoadedScene, Vec3 } from 'steel-webgpu';
import { skyNode, studioFog } from './studio';

export const DEFAULT_CAMERA: { eye: Vec3; target: Vec3 } = { eye: [1.25, -1.6, 1.25], target: [0.1, 0.05, 0.15] };

/** COM poses (8 floats per body) of the bodies at their initial origin transforms, bodies.q. */
export function initialPoses(scene: LoadedScene) {
  const { q, com } = scene.json.bodies;
  const poses = new Float32Array(q.length * 8);
  const rotation = new Quaternion();
  const c = new Vector3();
  q.forEach((xf, b) => {
    rotation.set(xf[3], xf[4], xf[5], xf[6]);
    c.set(...com[b]).applyQuaternion(rotation);
    poses.set([xf[0] + c.x, xf[1] + c.y, xf[2] + c.z, 0, xf[3], xf[4], xf[5], xf[6]], b * 8);
  });
  return poses;
}

/** Renders scenes in their initial state into 2D canvases, for gallery thumbnails; no simulation is built. */
export class ScenePreviewer {
  private readonly renderer: WebGPURenderer;
  private readonly ready: Promise<void>;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGPURenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.ready = this.renderer.init().then(() => undefined);
  }

  async draw(sceneUrl: string, out: HTMLCanvasElement) {
    await this.ready;
    const scene = await loadScene(sceneUrl);
    const view = scene.json.info.camera ?? DEFAULT_CAMERA;
    const graph = new SceneGraph(scene, view.target);
    graph.initialPoses(initialPoses(scene));
    await graph.texturesReady();
    const stage = new Scene();
    stage.backgroundNode = skyNode;
    stage.fog = studioFog();
    stage.add(graph.root);
    const { width, height } = this.canvas.getBoundingClientRect();
    this.renderer.setSize(width, height, false);
    const camera = new PerspectiveCamera(40, width / height, 0.01, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(...view.eye);
    camera.lookAt(...view.target);
    // The WebGPU canvas holds the frame only until the task ends, so copy it out in the same task.
    this.renderer.render(stage, camera);
    out.getContext('2d')!.drawImage(this.canvas, 0, 0, out.width, out.height);
    graph.dispose();
  }

  dispose() {
    return this.renderer.dispose();
  }
}
