import { useState } from 'react';
import { SceneBuilder, type LoadedScene, type Vec3 } from 'steel-webgpu';
import type { BodyNames, BuildOp, BuildRegistry } from './context';

export interface DeclarativeOptions {
  gravity?: Vec3;
  fps?: number;
}

/** The build ops of a <Scene>'s declarative children, counting every change. */
export class OpRegistry implements BuildRegistry {
  private readonly items = new Set<BuildOp>();
  private changes = 0;

  constructor(private readonly onChange: (changes: number) => void) {}

  register(op: BuildOp) {
    this.items.add(op);
    this.changed();
    return () => {
      this.items.delete(op);
      this.changed();
    };
  }

  ops() {
    return [...this.items];
  }

  // Children register in layout effects; a load started before their latest change lands would be redone at once.
  isSettled(version: number) {
    return version === this.changes;
  }

  private changed() {
    this.onChange(++this.changes);
  }
}

/** A registry for declarative children and a version that changes whenever they do. */
export function useBuildRegistry() {
  const [version, setVersion] = useState(0);
  const [registry] = useState(() => new OpRegistry(setVersion));
  return { registry, version };
}

function jointDepth(op: BuildOp, parentOf: Map<string, string | null>) {
  let depth = 0;
  for (let name = op.joint?.parent ?? null; name !== null && depth < parentOf.size; name = parentOf.get(name) ?? null) depth++;
  return depth;
}

/** Runs the ops phase by phase (bodies, colliders, joints with parents first) and finalizes the scene. */
export async function buildScene(ops: BuildOp[], { gravity, fps }: DeclarativeOptions): Promise<LoadedScene> {
  const builder = new SceneBuilder({ gravity, fps });
  const names: BodyNames = new Map();
  const phase = (n: BuildOp['phase']) => ops.filter((op) => op.phase === n);
  for (const op of phase(0)) await op.run(builder, names);
  for (const op of phase(1)) await op.run(builder, names);
  const joints = phase(2);
  const parentOf = new Map(joints.map((op) => [op.joint!.child, op.joint!.parent]));
  joints.sort((a, b) => jointDepth(a, parentOf) - jointDepth(b, parentOf));
  for (const op of joints) await op.run(builder, names);
  const scene = builder.finalize();
  for (const op of ops) op.after?.(builder);
  return scene;
}
