import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // The price snapshot reader is a second entry rather than part of the root
  // export: it reads a 2 MB payload from disk, so `apps/web` must not be able
  // to reach it by importing the package.
  entry: ['src/index.ts', 'src/pricing/snapshot.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  // The reader resolves the payload relative to its own file, which needs
  // `import.meta.url` to survive the CommonJS build.
  shims: true,
  sourcemap: true,
  // Emptying dist on every watch rebuild leaves a window where dependents
  // resolve a module that briefly does not exist, and tsx exits rather than
  // retrying. A one-off build still starts from a clean directory.
  clean: !options.watch,
  treeshake: true,
  external: ['reactflow'],
}));
