import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

// Turbopack has no custom export conditions, so the workspace packages are aliased to their sources, as the `@skild-ai/source` condition does for Vite.
const workspaceSources = {
  '@skild-ai/steel-webgpu': '../../packages/core/src/index.ts',
  '@skild-ai/steel-webgpu/device': '../../packages/core/src/deviceEntry.ts',
  '@skild-ai/steel-webgpu-three': '../../packages/three/src/index.ts',
  '@skild-ai/steel-webgpu-react': '../../packages/react/src/index.ts',
};

const config: NextConfig = {
  turbopack: { root: workspaceRoot, resolveAlias: workspaceSources },
  agentRules: false,
};

export default config;
