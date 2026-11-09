import { ACESFilmicToneMapping, PCFShadowMap, type Scene, WebGPURenderer } from 'three/webgpu';
import { skyNode, studioFog } from './studio';

export interface StudioRendererOptions {
  canvas: HTMLCanvasElement;
  /** The device the Sim runs on; render and physics must share it for the GPU-to-GPU pose copy. */
  device: GPUDevice;
  antialias?: boolean;
}

/** A WebGPURenderer on the Sim's device with the studio look's shadows and tone mapping, ready to draw. */
export async function createStudioRenderer({ canvas, device, antialias = true }: StudioRendererOptions) {
  const renderer = new WebGPURenderer({ canvas, device, antialias });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  await renderer.init();
  return renderer;
}

/** The studio sky and fog on a three scene. */
export function applyStudio(scene: Scene) {
  scene.backgroundNode = skyNode;
  scene.fog = studioFog();
  return scene;
}
