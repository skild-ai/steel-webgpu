import { defineConfig } from 'vite-plus';

export default defineConfig({
  resolve: { conditions: ['@skild-ai/source'] },
  build: { target: 'es2022' },
});
