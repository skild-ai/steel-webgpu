import type { SteelWorld } from '@steel-webgpu/three';
import { createContext, useContext } from 'react';
import type { SceneBuilder } from 'steel-webgpu';

export const DeviceContext = createContext<GPUDevice | null>(null);
export const WorldContext = createContext<SteelWorld | null>(null);

/** Bodies by name, filled in while a declarative scene is built. */
export type BodyNames = Map<string, number>;

/**
 * One step of building a declarative scene. Phases run in order: bodies and robots, then colliders, then joints;
 * `after` runs once the Sim exists, e.g. to resolve joint dofs for handles.
 */
export interface BuildOp {
  phase: 0 | 1 | 2;
  run(builder: SceneBuilder, names: BodyNames): void | Promise<void>;
  after?(builder: SceneBuilder): void;
  /** Joint ops: child and parent body names, so parents' joints are added first. */
  joint?: { child: string; parent: string | null };
}

export interface BuildRegistry {
  register(op: BuildOp): () => void;
}

export const BuildContext = createContext<BuildRegistry | null>(null);

/** The body slot a collider or joint attaches to: its name and, once built, its index. */
export interface BodySlot {
  name: string;
  index: number;
}

export const BodyContext = createContext<BodySlot | null>(null);

export function useDevice() {
  const device = useContext(DeviceContext);
  if (!device) throw new Error('useDevice must be used inside <Physics>');
  return device;
}

/** The current scene's world, or null while it loads. Use inside <Scene>. */
export const useWorld = () => useContext(WorldContext);
