import { applyStudio, createStudioRenderer, sceneLoader } from '@skild-ai/steel-webgpu-three';
import { Canvas, type CanvasProps, type RootState } from '@react-three/fiber';
import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import type { WebGPURenderer } from 'three/webgpu';
import { initDevice, UnsupportedError } from '@skild-ai/steel-webgpu';
import { DeviceContext } from './context';

export interface PhysicsProps extends Omit<CanvasProps, 'gl' | 'children'> {
  children?: ReactNode;
  /** Shown instead of the canvas when the browser cannot run the solver. */
  unsupported?: (reason: string) => ReactNode;
  /** Shown while the device is requested. */
  fallback?: ReactNode;
  onError?: (error: unknown) => void;
  /** The studio sky and fog; set false to light and dress the scene yourself. */
  studio?: boolean;
}

type DeviceState = { kind: 'pending' } | { kind: 'ready'; device: GPUDevice } | { kind: 'unsupported'; reason: string };

/**
 * Owns the WebGPU device and the R3F canvas whose renderer shares it. Both are created once and reused by every
 * <Scene> inside, so switching scenes rebuilds only the Sim and its scene graph.
 */
export function Physics({ children, unsupported, fallback = null, onError, studio = true, onCreated, ...canvasProps }: PhysicsProps) {
  const [state, setState] = useState<DeviceState>({ kind: 'pending' });
  const [drawn, setDrawn] = useState(false);
  const reportError = useEffectEvent((error: unknown) => (onError ?? console.error)(error));

  useEffect(() => {
    // Starts the loader's worker while the device is requested, so the first scene fetch does not wait for it.
    sceneLoader();
    const abort = new AbortController();
    const owned: { device?: GPUDevice } = {};
    initDevice().then(
      (device) => {
        if (abort.signal.aborted) return device.destroy();
        owned.device = device;
        setState({ kind: 'ready', device });
      },
      (error) => {
        if (abort.signal.aborted) return;
        if (error instanceof UnsupportedError) setState({ kind: 'unsupported', reason: error.message });
        else reportError(error);
      },
    );
    return () => {
      abort.abort();
      owned.device?.destroy();
    };
  }, []);

  if (state.kind === 'unsupported') return <>{unsupported?.(state.reason) ?? null}</>;
  if (state.kind === 'pending') return <>{fallback}</>;
  const { device } = state;
  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 1.5]}
      camera={{ fov: 40, near: 0.01, far: 1000, up: [0, 0, 1], position: [1.25, -1.6, 1.25] }}
      {...canvasProps}
      gl={({ canvas }) => createStudioRenderer({ canvas: canvas as HTMLCanvasElement, device })}
      onCreated={(root) => {
        warmUp(root, studio);
        setDrawn(true);
        onCreated?.(root);
      }}
    >
      {drawn && <DeviceContext.Provider value={device}>{children}</DeviceContext.Provider>}
    </Canvas>
  );
}

/** Draws the empty stage once, so the renderer's own pipelines (sky, output pass) are built before any scene loads. */
function warmUp({ gl, scene, camera }: RootState, studio: boolean) {
  if (studio) applyStudio(scene);
  (gl as unknown as WebGPURenderer).render(scene, camera);
}
