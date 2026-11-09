import tgpu, { type TgpuBuffer, type TgpuRoot } from 'typegpu';
import * as d from 'typegpu/data';

/** One body in the solver's `poses` buffer (wgsl.js): COM position (w unused), then orientation quaternion (x, y, z, w). */
export const BodyPose = d.struct({ com: d.vec4f, quat: d.vec4f });

export const bodyPoses = (count: number) => d.arrayOf(BodyPose, count);
export type BodyPoses = ReturnType<typeof bodyPoses>;

export const VEC4_PER_POSE = d.sizeOf(BodyPose) / d.sizeOf(d.vec4f);

/**
 * Copies body poses from the solver's buffer into the buffer the renderer draws from, GPU to GPU.
 * Both are views of GPUBuffers owned elsewhere (the Sim and three), typed with the same schema.
 */
export class PoseBridge {
  private readonly root: TgpuRoot;
  private readonly schema: BodyPoses;
  private source: TgpuBuffer<BodyPoses>;
  private target: TgpuBuffer<BodyPoses> | null = null;

  constructor(device: GPUDevice, bodyCount: number, simPoses: GPUBuffer) {
    this.root = tgpu.initFromDevice({ device });
    this.schema = bodyPoses(bodyCount);
    this.source = this.root.createBuffer(this.schema, simPoses);
  }

  setSource(simPoses: GPUBuffer) {
    this.source = this.root.createBuffer(this.schema, simPoses);
  }

  /** Returns false while the render buffer does not exist yet (three creates it on first draw). */
  copy(renderPoses: () => GPUBuffer | undefined): boolean {
    if (!this.target) {
      const buffer = renderPoses();
      if (!buffer) return false;
      this.target = this.root.createBuffer(this.schema, buffer);
    }
    this.target.copyFrom(this.source);
    return true;
  }

  dispose() {
    this.root.destroy();
  }
}
