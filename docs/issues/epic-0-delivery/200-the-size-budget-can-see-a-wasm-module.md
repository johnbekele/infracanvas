---
title: '[ci] Give the size budget sight of WebAssembly before the simulation core arrives'
labels: tier:3, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

`scripts/ci/check-bundle-size.mjs` collects what it weighs by scanning each `.html` in the dist
directory for `<script[^>]+src="([^"]+\.js)">`. Two consequences follow, and only one of them was
intended.

The intended one is that lazily-loaded route chunks are excluded, and the script says so: _"pushing
weight behind a dynamic import is exactly the behaviour this budget is meant to encourage."_ That is
right, and `apps/web/src/App.tsx` already lazy-loads the designer, settings and repository routes.

The unintended one is that a `.wasm` asset is never weighed at all, under any circumstances. It is not
matched by the `\.js` pattern and it is not referenced from `index.html`. Today that costs nothing,
because the repository contains no WebAssembly. `docs/issues/ROADMAP.md` Phase 2 ports the simulation
core to Rust and ships it to the browser as WebAssembly, at which point the gate would report green
while the application grew by a megabyte, and `docs/DELIVERY.md`'s stated budget — _"initial JS under
250 KB gzip"_ — would be technically satisfied and substantively meaningless.

Fixing this after the core lands means discovering the real number at the moment there is the most
pressure to wave it through. Fixing it before means the first WebAssembly pull request has a budget to
come in under, and the ratchet is set from a measurement rather than a negotiation.

The budget is expressed as two numbers rather than one, because the two failure modes are different.
**Initial** WebAssembly — reachable from the entry chunk — must stay at zero: the simulation core
belongs to the designer route, which is already lazy, and anything that drags it into the entry chunk
is a regression in module graph shape, not a size problem. **Lazy** WebAssembly gets a generous
ceiling that ratchets, because that is where the core legitimately lives.

Vite records which assets belong to which chunk in its manifest, so neither number has to be inferred
by parsing HTML. Building with `manifest: true` is a one-line change to `apps/web/vite.config.ts` and
gives the script a real module graph to walk instead of a regular expression over markup.

Spec: `docs/DELIVERY.md`

### Contract

```javascript
// scripts/ci/check-bundle-size.mjs

/**
 * Weigh a built application against its budgets.
 *
 * `entry` is everything reachable from the HTML entry points; `lazy` is
 * everything reachable only through a dynamic import. WebAssembly is weighed
 * separately from JavaScript because a wasm module in the entry graph is a
 * shape regression rather than a size one.
 */
export function measure(distDir) {
  return {
    entryJsGzipBytes: 0,
    entryWasmGzipBytes: 0,
    lazyWasmGzipBytes: 0,
    chunks: [], // { file, kind: 'js' | 'wasm', graph: 'entry' | 'lazy', gzipBytes }
  };
}
```

```jsonc
// perf-budgets.json
{
  "webInitialJsGzipKb": 215,
  "webInitialWasmGzipKb": 0,
  "webLazyWasmGzipKb": 400,
  "diffCoveragePercent": 0,
}
```

### Files

- `scripts/ci/check-bundle-size.mjs` — MODIFY: read the Vite manifest, classify each asset as entry or
  lazy and as JavaScript or WebAssembly, weigh all four categories, and fail against the three budgets.
  Keep the existing per-chunk table.
- `scripts/ci/check-bundle-size.test.mjs` — CREATE: the cases below, over fixture manifests.
- `apps/web/vite.config.ts` — MODIFY: `build.manifest = true`.
- `perf-budgets.json` — MODIFY: add the two WebAssembly budgets.
- `docs/DELIVERY.md` — MODIFY: state that the web budget covers WebAssembly, and cite the budget file.

### Acceptance Criteria

- [ ] A `.wasm` asset reachable from the entry chunk fails the gate.
- [ ] A `.wasm` asset reachable only through a dynamic import is weighed against the lazy budget and does not count toward the initial one.
- [ ] Lazily-loaded JavaScript continues to be excluded from the initial budget.
- [ ] The failure message names the offending asset, its gzipped size and the budget it broke.
- [ ] Building `apps/web` today reports zero WebAssembly in both graphs and stays green.
- [ ] The gate reads every budget from `perf-budgets.json`.

### Required Tests

- `counts a wasm module reachable from the entry chunk` — a fixture manifest whose entry imports a
  `.wasm` asset reports it under `entryWasmGzipBytes` and fails the zero budget.
- `does not count a wasm module behind a dynamic import` — the same asset, reached only through a lazy
  chunk, lands in `lazyWasmGzipBytes` and leaves the initial budget at zero.
- `still ignores lazily-loaded javascript` — the behaviour the current script was written for, asserted
  so this change cannot quietly reverse it.
- `names the asset and the budget it broke` — the error message contains the file name and both
  numbers, because a size failure that does not say what grew sends the reader to a treemap.
- `fails when the manifest is absent` — a build without `manifest: true` errors rather than silently
  weighing nothing and passing.

### Performance Budget

The script must complete in under five seconds on the current `apps/web` build. It gzips each asset
once; reading the manifest replaces a directory walk, so it should get faster rather than slower.

### Out of Scope

- Reducing the current bundle. Issue #175 tracks the initial JavaScript being over target, and it
  correctly insists on a treemap before any cutting.
- Any Rust, WebAssembly or simulation-core work. This issue only teaches the gate to see it.
- Brotli. The budgets are gzip because the existing one is, and changing the compression and the
  categories in one step makes a regression impossible to attribute.

### Dependencies

Blocked by `docs/issues/epic-0-delivery/190-coverage-is-enforced-at-a-ratchet.md` (Epic #1), which
creates `perf-budgets.json`. If that has not landed, create the file here instead and note it.

### Verification

```bash
pnpm turbo build --filter=@infracanvas/web
node scripts/ci/check-bundle-size.mjs apps/web/dist
node --test scripts/ci/check-bundle-size.test.mjs
```

Then prove the new budget bites, by adding a WebAssembly asset to the entry graph on a scratch branch
and watching the gate fail with the asset named.
