---
title: '[ci] Make pnpm dev start from a clean tree'
labels: tier:2, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

`pnpm dev` at the repository root does not work from a fresh clone. The API exits immediately with:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../apps/api/node_modules/@infracanvas/core/dist/index.mjs'
  imported from .../apps/api/src/lib/analysis/analyze.ts
```

Two causes compound.

The `dev` task declares no dependency, so Turbo starts every package's dev task at once.
`@infracanvas/core` resolves through its `dist` output, and on a fresh clone that directory does not
exist yet, so the API loses the race against the first build.

Even once it exists, `packages/core` runs `tsup --watch` with `clean: true`, which empties `dist`
at the start of every rebuild. Any dependent that resolves the module inside that window fails, and
`tsx watch` treats an unresolved import as fatal and exits rather than retrying on the next change.
Editing a file under `packages/core` therefore kills the API server.

This became visible when the repository analysis routes began importing `@infracanvas/core`; before
that the API never touched the package at runtime and the race had nothing to lose.

### Contract

No new interfaces.

```jsonc
// turbo.json
"dev": {
  "dependsOn": ["^build"],
  "cache": false,
  "persistent": true
}
```

```typescript
// packages/core/tsup.config.ts
export default defineConfig((options) => ({
  // ...
  clean: !options.watch,
}));
```

A one-off build still starts from an empty directory; only the watch mode keeps the previous output
in place so dependents always resolve something valid.

### Files

- MODIFY `turbo.json` - build workspace dependencies before starting any dev task
- MODIFY `packages/core/tsup.config.ts` - do not empty `dist` on a watch rebuild

### Acceptance Criteria

- [ ] `rm -rf packages/core/dist .turbo && pnpm dev` brings up both servers
- [ ] `/health` reports `{"status":"ok","database":"up"}` without a prior manual build
- [ ] Editing a file under `packages/core/src` rebuilds without killing the API server

### Required Tests

Manual, since this concerns process startup and the task graph rather than a unit:

- `rm -rf packages/core/dist .turbo && pnpm dev`, then `curl localhost:3001/health`
- Append a line to `packages/core/src/index.ts`, wait for the rebuild, and `curl` again

### Performance Budget

n/a. `dependsOn` adds one cached build to dev startup.

### Out of Scope

- Do not change the `build`, `lint`, `test`, or `typecheck` task definitions
- Do not switch `@infracanvas/core` to resolve through source rather than `dist`; that is a larger
  change to how the package is consumed and deserves its own issue

### Dependencies

none

### Verification

```bash
rm -rf packages/core/dist .turbo
pnpm dev
curl -s localhost:3001/health
```

### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
