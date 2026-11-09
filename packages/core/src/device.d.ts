import type { LoadedScene } from './sceneTypes';
import type { SimOptions } from './sim.js';

/** The browser or GPU lacks a capability the solver needs; nothing was downloaded or allocated. */
export declare class UnsupportedError extends Error {}

/** Requests a WebGPU device with the features and limits the solver uses (subgroups when available). */
export declare function initDevice(): Promise<GPUDevice>;

/** Fasteners inside the bin, for bolt_sweep style scenes. */
export declare function binCount(scene: LoadedScene, poses: Float32Array): number;
/** The demo progress label and value shown in the viewer HUD, or null when the scene tracks nothing. */
export declare function metric(scene: LoadedScene, poses: Float32Array): [string, string] | null;
export declare function demoName(): string;
export declare function simOptions(): SimOptions;
