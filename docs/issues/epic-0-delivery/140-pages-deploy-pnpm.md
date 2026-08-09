---
title: '[ci] Pages deploy builds with a different pnpm than the gates'
labels: tier:2, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

`Deploy to GitHub Pages` has failed on every push to `main` since the delivery infrastructure landed:

```
Error: Multiple versions of pnpm specified:
Remove one of these versions to avoid version mismatch errors like ERR_PNPM_BAD_PM_VERSION
```

The workflow asks `pnpm/action-setup` for version 9 while `package.json` declares
`"packageManager": "pnpm@8.15.0"`, and v4 of that action refuses to guess between them.

The deeper problem is that the deploy workflow set up its own toolchain at all. Every gate uses the
`./.github/actions/setup-node` composite, so the deploy was building the site with a different
package manager than the checks that approved the commit. The version conflict is what made that
visible; it was wrong before it was noisy.

Gate 6 measures the bundle this workflow ships, so the two must agree on how it is built.

Spec: `docs/DELIVERY.md`

### Contract

`.github/workflows/deploy.yml` uses the shared composite action rather than its own pnpm, Node, and
install steps:

```yaml
- uses: ./.github/actions/setup-node
```

### Files

- MODIFY `.github/workflows/deploy.yml` - replace the bespoke toolchain steps with the shared action

### Acceptance Criteria

- [ ] `Deploy to GitHub Pages` succeeds on a push to `main`
- [ ] The workflow declares no pnpm version of its own; `packageManager` is the single source
- [ ] The site is built with the same pnpm and Node version as every gate
- [ ] `apps/web/dist` is still the uploaded artifact path

### Required Tests

- `the pages deploy succeeds on main` - observe a green run after merge
- `no workflow pins a pnpm version that disagrees with packageManager` - grep every workflow and the
  composite action for `pnpm/action-setup` and compare each `version` against `package.json`

### Performance Budget

n/a

### Out of Scope

- Do not change the pnpm version in `package.json`; that is a dependency bump with its own blast radius
- Do not change what the site deploys or where it deploys from

### Dependencies

none

### Verification

```bash
gh run list --branch main --workflow "Deploy to GitHub Pages" --limit 1
grep -rn -A2 "pnpm/action-setup" .github/workflows .github/actions
grep -n packageManager package.json
```

### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
