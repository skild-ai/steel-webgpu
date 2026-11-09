import { defineConfig } from 'vite-plus';

export default defineConfig({
  resolve: { conditions: ['source'] },
  build: { target: 'es2022' },
});
