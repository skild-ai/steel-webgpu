import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: { index: 'src/index.ts', device: 'src/deviceEntry.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    platform: 'browser',
  },
});
