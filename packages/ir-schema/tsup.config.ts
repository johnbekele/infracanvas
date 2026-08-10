import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  // Matches packages/core: emptying dist on every watch rebuild leaves a window
  // where a dependent resolves a module that briefly does not exist.
  clean: !options.watch,
  treeshake: true,
}));
