import { describe, expect, test } from 'vite-plus/test';
import type { LoadedScene } from '@skild-ai/steel-webgpu';
import { PerspectiveCamera } from 'three/webgpu';
import { applyCameraView, readCameraView, sceneView, type CameraView } from '../src/cameraView';
import { DEFAULT_CAMERA } from '../src/scenePreviewer';

const sceneWithCamera = (camera?: LoadedScene['json']['info']['camera']) => ({ json: { info: { camera } } }) as unknown as LoadedScene;

describe('camera views', () => {
  test('a given view overrides the scene viewpoint, which falls back to the default', () => {
    const override: CameraView = { position: [3, 0, 1], target: [0, 0, 0.5], fov: 30 };
    expect(sceneView(sceneWithCamera({ eye: [1, 1, 1], target: [0, 0, 0] }), override)).toEqual(override);
    expect(sceneView(sceneWithCamera({ eye: [1, 1, 1], target: [0, 0, 0] }))).toEqual({ position: [1, 1, 1], target: [0, 0, 0] });
    expect(sceneView(sceneWithCamera())).toEqual({ position: DEFAULT_CAMERA.eye, target: DEFAULT_CAMERA.target });
  });

  test('an applied view reads back unchanged, and a view without fov keeps the camera fov', () => {
    const camera = new PerspectiveCamera(40, 1, 0.01, 100);
    applyCameraView(camera, { position: [2, -1, 1.5], target: [0, 0, 0.2], fov: 25 });
    expect(readCameraView(camera, [0, 0, 0.2])).toEqual({ position: [2, -1, 1.5], target: [0, 0, 0.2], fov: 25 });
    expect(camera.up.toArray()).toEqual([0, 0, 1]);
    applyCameraView(camera, { position: [1, 1, 1], target: [0, 0, 0] });
    expect(camera.fov).toBe(25);
  });
});
