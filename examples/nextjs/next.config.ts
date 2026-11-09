import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

// Turbopack has no custom export conditions, so the workspace packages are aliased to their sources, as the `source` condition does for Vite.
const workspaceSources = {
  'steel-webgpu': '../../packages/core/src/index.ts',
  'steel-webgpu/device': '../../packages/core/src/deviceEntry.ts',
  '@steel-webgpu/three': '../../packages/three/src/index.ts',
  '@steel-webgpu/react': '../../packages/react/src/index.ts',
};

const config: NextConfig = {
  turbopack: { root: workspaceRoot, resolveAlias: workspaceSources },
  agentRules: false,
};

export default config;
