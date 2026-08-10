import { defineConfig } from 'vitest/config';
import path from 'path';

// Logic that can be tested without a DOM lives under src/lib. Component tests
// would need jsdom and a testing library; keeping the rules they enforce out of
// the components is what makes that unnecessary here.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
