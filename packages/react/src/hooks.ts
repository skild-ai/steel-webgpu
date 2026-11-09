import type { SteelWorld, StepCallback } from '@skild-ai/steel-webgpu-three';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Sim, SimStats } from '@skild-ai/steel-webgpu';
import { useWorld } from './context';

function useStepCallback(phase: 'beforeStep' | 'afterStep', callback: StepCallback) {
  const world = useWorld();
  const onStep = useEffectEvent(callback);
  useEffect(() => {
    if (!world) return;
    const call: StepCallback = (sim) => onStep(sim);
    world[phase].add(call);
    return () => void world[phase].delete(call);
  }, [world, phase]);
}

/** Runs before every physics step, e.g. to drive kinematic bodies. Registers once; returns nothing per frame. */
export const useBeforeStep = (callback: StepCallback) => useStepCallback('beforeStep', callback);

/** Runs after every physics step was submitted. */
export const useAfterStep = (callback: StepCallback) => useStepCallback('afterStep', callback);

/** What a policy sees each step; the object is reused, copy what you keep. */
export interface PolicyState {
  /** Simulated seconds. */
  time: number;
  /** Latest pose snapshot (COM xyz, pad, quaternion xyzw per body), one frame behind; null before the first. */
  poses: Float32Array | null;
}

/** The controls a policy acts through. */
export type PolicyControl = Pick<Sim, 'setJointTarget' | 'setJointTargets' | 'setJointForce' | 'setBodyWrench' | 'setBodyPose' | 'setBodyTwist'>;

/**
 * Calls `policy(state, ctrl)` before every physics step with the latest pose snapshot. While mounted, the world
 * keeps one pooled pose readback per stepped frame going; rendering itself never reads back.
 */
export function usePolicy(policy: (state: PolicyState, ctrl: PolicyControl) => void) {
  const world = useWorld();
  const state = useRef<PolicyState>({ time: 0, poses: null });
  useEffect(() => world?.subscribePoses(), [world]);
  useBeforeStep((sim) => {
    state.current.time = sim.time;
    state.current.poses = world?.poses() ?? null;
    policy(state.current, sim);
  });
}

export interface SimStatsSample extends SimStats {
  /** Simulated seconds when sampled. */
  time: number;
}

/** Solver stats sampled `hz` times a second (default 4); re-renders only at that rate. */
export function useSimStats({ hz = 4 }: { hz?: number } = {}) {
  const world = useWorld();
  const [sampled, setSampled] = useState<{ world: SteelWorld; stats: SimStatsSample } | null>(null);
  useEffect(() => {
    if (!world) return;
    let active = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      world
        .requestStats()
        .then((sample) => active && setSampled({ world, stats: { ...sample, time: world.sim.time } }))
        .finally(() => (inFlight = false));
    }, 1000 / hz);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [world, hz]);
  return sampled?.world === world ? sampled.stats : null;
}
