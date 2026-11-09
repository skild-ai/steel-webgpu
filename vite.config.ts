import { defineConfig } from 'vite-plus';

// Upstream's engine, tools and exported scenes stay byte-for-byte as upstream writes them, so main merges apply cleanly.
const upstream = ['assets/**', 'packages/core/src/*.js', 'tools/**'];

export default defineConfig({
  fmt: {
    singleQuote: true,
    printWidth: 160,
    ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/.next/**', 'bun.lock', '**/*.md', ...upstream],
  },
  lint: {
    plugins: ['typescript', 'react', 'oxc'],
    ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/.next/**', ...upstream],
  },
  // Tests import the workspace packages from source, so they run without a prior build.
  ssr: { resolve: { conditions: ['@skild-ai/source'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
