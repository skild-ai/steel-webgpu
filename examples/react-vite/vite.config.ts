import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@skild-ai/source'] },
  build: { target: 'es2022' },
});
