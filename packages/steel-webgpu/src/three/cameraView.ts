import type { LoadedScene, Vec3 } from '../index';
import type { PerspectiveCamera } from 'three/webgpu';
import { DEFAULT_CAMERA } from './scenePreviewer';

/** A viewpoint in the scene's world frame (Z up, meters); `fov` is the vertical field of view in degrees. */
export interface CameraView {
  position: Vec3;
  target: Vec3;
  fov?: number;
}

/** The given view, or else the scene's own viewpoint. */
export function sceneView(scene: LoadedScene, override?: CameraView): CameraView {
  if (override) return override;
  const { eye, target } = scene.json.info.camera ?? DEFAULT_CAMERA;
  return { position: eye, target };
}

/** Places a Z-up camera at `view`; without a `fov`, the camera keeps its own. */
export function applyCameraView(camera: PerspectiveCamera, view: CameraView) {
  camera.up.set(0, 0, 1);
  camera.position.set(...view.position);
  camera.lookAt(...view.target);
  if (view.fov !== undefined && view.fov !== camera.fov) {
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
  }
}

/** The camera's current view, looking at `target`. */
export function readCameraView(camera: PerspectiveCamera, target: Vec3): CameraView {
  return { position: camera.position.toArray(), target: [...target], fov: camera.fov };
}
