import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  // Emptying dist on every watch rebuild leaves a window where dependents
  // resolve a module that briefly does not exist, and tsx exits rather than
  // retrying. A one-off build still starts from a clean directory.
  clean: !options.watch,
  treeshake: true,
  external: ['reactflow'],
}));
