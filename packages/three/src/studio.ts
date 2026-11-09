import {
  CanvasTexture,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  DirectionalLight,
  Fog,
  HemisphereLight,
  LinearSRGBColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';
import { Fn, exp, length, mix, pow, screenUV, vec2, vec3 } from 'three/tsl';
import type { Vec3 } from '@skild-ai/steel-webgpu';

// avbd-metal's studio look: a screen-space sky gradient with a warm glow, a 1 m checker floor that
// fogs into the horizon colour, hemisphere ambient, a warm sun and ACES tone mapping.
const HORIZON: Vec3 = [0.78, 0.81, 0.85];
const ZENITH: Vec3 = [0.5, 0.56, 0.66];
const GLOW: Vec3 = [0.3, 0.25, 0.16];
const SUN_DIR = new Vector3(0.4, 0.25, -0.85).normalize();
const SUN_DISTANCE = 4;
const FOG_NEAR = 90;
const FOG_FAR = 420;

export const linear = (r: number, g: number, b: number) => new Color().setRGB(r, g, b, LinearSRGBColorSpace);

export const skyNode = Fn(() => {
  const t = screenUV.y.oneMinus();
  const glow = exp(length(vec2(screenUV.x.mul(2).sub(1).add(0.45), t.mul(2).sub(1).sub(0.55))).mul(-3));
  return mix(vec3(...HORIZON), vec3(...ZENITH), pow(t, 1.7)).add(vec3(...GLOW).mul(glow));
})();

export const studioFog = () => new Fog(linear(...HORIZON), FOG_NEAR, FOG_FAR);

export function studioLights(target: Vec3) {
  // three's Lambert divides irradiance by pi; avbd's ambient term does not.
  const ambient = new HemisphereLight(linear(0.3, 0.33, 0.38), linear(0.2, 0.185, 0.17), Math.PI);
  const sun = new DirectionalLight(linear(1.0, 0.95, 0.86), 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.004;
  Object.assign(sun.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5, near: 0.1, far: 8 });
  sun.target.position.set(...target);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, -SUN_DISTANCE);
  return [ambient, sun, sun.target];
}

const CHECKER_SIZE = 256;
const CHECKER_LIGHT = 'rgb(237,237,240)';
const CHECKER_DARK = 'rgb(158,168,184)';
const CHECKER_LIGHT_TEXEL = [237, 237, 240, 255];
const CHECKER_DARK_TEXEL = [158, 168, 184, 255];

export function checkerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CHECKER_SIZE;
  const g = canvas.getContext('2d')!;
  const half = CHECKER_SIZE / 2;
  g.fillStyle = CHECKER_LIGHT;
  g.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  g.fillStyle = CHECKER_DARK;
  g.fillRect(0, 0, half, half);
  g.fillRect(half, half, half, half);
  return floorSampling(new CanvasTexture(canvas));
}

/**
 * The same texels as `checkerTexture`, built without a 2D canvas: a page's first 2D context costs tens of
 * milliseconds, which would land in the first scene load. Rows run bottom-up, as the canvas texture's flipY uploads them.
 */
export function checkerDataTexture() {
  const half = CHECKER_SIZE / 2;
  const data = new Uint8Array(CHECKER_SIZE * CHECKER_SIZE * 4);
  for (let row = 0; row < CHECKER_SIZE; row++) {
    for (let x = 0; x < CHECKER_SIZE; x++) data.set(x < half === row >= half ? CHECKER_DARK_TEXEL : CHECKER_LIGHT_TEXEL, (row * CHECKER_SIZE + x) * 4);
  }
  const tex = new DataTexture(data, CHECKER_SIZE, CHECKER_SIZE);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return floorSampling(tex);
}

function floorSampling<T extends CanvasTexture | DataTexture>(tex: T) {
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}
