import { afterEach, expect, test } from 'vite-plus/test';
import { initDevice, UnsupportedError } from '../src';

const realGpu = Object.getOwnPropertyDescriptor(globalThis.navigator, 'gpu');
const fakeAdapter = (features: string[], subgroupMaxSize: number) => ({
  limits: {},
  features: new Set(features),
  info: { subgroupMaxSize },
  requestDevice: () => {
    throw new Error('a device must not be requested');
  },
});
const withGpu = (gpu: unknown) => Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });

afterEach(() => {
  if (realGpu) Object.defineProperty(globalThis.navigator, 'gpu', realGpu);
  else delete (globalThis.navigator as { gpu?: unknown }).gpu;
});

test('rejects a browser without WebGPU as unsupported', async () => {
  withGpu(undefined);
  await expect(initDevice()).rejects.toBeInstanceOf(UnsupportedError);
});

test('rejects a missing adapter as unsupported', async () => {
  withGpu({ requestAdapter: async () => null });
  await expect(initDevice()).rejects.toBeInstanceOf(UnsupportedError);
});

test('requests a device without subgroups when the adapter has fewer than 32 lanes', async () => {
  let requested: string[] = [];
  const adapter = {
    ...fakeAdapter(['subgroups', 'timestamp-query'], 16),
    requestDevice: async (d: { requiredFeatures: string[] }) => {
      requested = d.requiredFeatures;
      return { lost: new Promise(() => {}), addEventListener() {} };
    },
  };
  withGpu({ requestAdapter: async () => adapter });
  await initDevice();
  expect(requested).toEqual(['timestamp-query']);
});
