import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

// Turbopack has no custom export conditions, so the workspace packages are aliased to their sources, as the `@skild-ai/source` condition does for Vite.
const workspaceSources = {
  '@skild-ai/steel-webgpu': '../../packages/steel-webgpu/src/index.ts',
  '@skild-ai/steel-webgpu/device': '../../packages/steel-webgpu/src/deviceEntry.ts',
  '@skild-ai/steel-webgpu/three': '../../packages/steel-webgpu/src/three/index.ts',
  '@skild-ai/steel-webgpu/react': '../../packages/steel-webgpu/src/react/index.ts',
};

const config: NextConfig = {
  turbopack: { root: workspaceRoot, resolveAlias: workspaceSources },
  agentRules: false,
};

export default config;
