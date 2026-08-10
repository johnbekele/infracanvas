---
title: '[api] Attribute analysis findings to the component that owns them'
labels: tier:2, size:l, area:api, epic:11-ui
---

### Epic

#12

### Context

The profiler already sees a monorepo clearly. Run it against a repository with 36 manifests, 11
Dockerfiles and 4 compose files and it reports all of them. What it does not report is which
component any of it belongs to.

`analyzeRepository` deduplicates dependencies on `${ecosystem}:${name}` across the whole repository,
so a single `celery` anywhere becomes the fact "this repository has background jobs" and the manifest
that actually declared it is reduced to a `sourcePath` on the first occurrence. `Component` carries a
`dependencyCount` and nothing else. The information that one service is a Celery worker and another
is a FastAPI app, which is the entire basis for proposing more than one compute node, is destroyed
before the profile is written.

Compose files are the other loss. They are discovered, listed in `containerisation.composeFiles`,
and never fetched. A compose file is the closest thing a repository has to a declaration of its own
topology: `build:` marks a service the repository builds, `image: postgres:16` marks infrastructure
it depends on, `depends_on` states the wiring, and `ports` states the real port assignments rather
than the union of every `EXPOSE` line in the tree.

This issue makes the profile per-component. It changes no proposal logic; the architecture engine
keeps consuming the profile as it does today and continues to emit what it emits. Splitting the two
keeps this diff reviewable and means a regression in either can be attributed.

Spec: `docs/issues/epic-11-web/010-connect-and-analyse-a-repository.md`

### Contract

```typescript
// packages/core/src/analysis/profile.ts
export const PROFILE_SCHEMA_VERSION = 2;

export type ComponentKind =
  | 'api'
  | 'worker'
  | 'frontend'
  | 'ml-service'
  | 'cron'
  | 'library'
  | 'test'
  | 'example'
  | 'unknown';

export interface Component {
  path: string;
  name: string;
  ecosystem: Ecosystem;
  kind: ComponentKind;
  manifestPath: string;
  /** Capabilities implied by this component's own dependencies, not the repository's. */
  capabilities: Capability[];
  dependencies: DetectedDependency[];
  /** Dockerfiles in this component's directory, nearest first. */
  dockerfiles: string[];
  /** EXPOSE ports from this component's own Dockerfiles. */
  exposedPorts: number[];
  /** The compose service that builds this component, when one does. */
  composeService: string | null;
  /** Whether this component is deployed, as opposed to imported by one that is. */
  deployable: boolean;
}

export interface ComposeService {
  name: string;
  file: string;
  /** Set when the service builds from source in this repository. */
  buildContext: string | null;
  /** Set when the service runs a published image. */
  image: string | null;
  /** Managed infrastructure this image implies, e.g. `postgres` for `postgres:16`. */
  capability: Capability | null;
  ports: number[];
  dependsOn: string[];
}

export interface AppProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  // ... existing fields unchanged ...
  components: Component[];
  /** Repository-wide rollup, retained for the summary view. */
  dependencies: DetectedDependency[];
  composeServices: ComposeService[];
}

export function deployables(profile: AppProfile): Component[];
export function componentsWith(profile: AppProfile, capability: Capability): Component[];
```

```typescript
// apps/api/src/lib/analysis/compose.ts
export function parseCompose(file: string, source: string): ComposeService[];
/** Maps `postgres:16-alpine` to `postgres`, `redis:7` to `redis`, and so on. */
export function capabilityForImage(image: string): Capability | null;
```

### Files

- MODIFY `packages/core/src/analysis/profile.ts` -- schema v2, per-component fields, helpers
- MODIFY `apps/api/src/lib/analysis/analyze.ts` -- attribute before dedup, classify components
- CREATE `apps/api/src/lib/analysis/compose.ts` -- compose parsing and image capability mapping
- CREATE `apps/api/src/lib/analysis/compose.test.ts`
- MODIFY `apps/api/src/lib/analysis/github-source.ts` -- raise manifest cap, bounded concurrency
- MODIFY `apps/api/src/lib/analysis/analyze.test.ts` -- per-component assertions
- MODIFY `apps/web/src/components/analysis/ProfileSummary.tsx` -- show per-component capabilities
- MODIFY `apps/api/package.json` -- add `yaml`

### Acceptance Criteria

- [ ] A dependency is recorded on the component whose manifest declared it, not only the first one
- [ ] Two components declaring the same dependency both report the capability it implies
- [ ] The repository-wide `dependencies` rollup still lists each dependency once
- [ ] A component with a web framework and a Dockerfile is classified `api`
- [ ] A component with a task-queue dependency and no exposed port is classified `worker`
- [ ] A component under `packages/` with no Dockerfile is classified `library` and is not deployable
- [ ] Components under `tests/`, `pocs/` and `_templates/` are not deployable
- [ ] A compose service with `build:` links to the component at that path
- [ ] A compose service running `postgres:16` yields a `postgres` capability without a component
- [ ] A Dockerfile is attributed to the component in whose directory it sits
- [ ] A profile written before this change is reported as outdated rather than misread

### Required Tests

- `records a dependency against every component that declares it`
- `keeps the repository rollup deduplicated`
- `classifies a FastAPI component with a Dockerfile as an api`
- `classifies a Celery component with no exposed port as a worker`
- `classifies a package with no Dockerfile as a non-deployable library`
- `excludes test and example directories from deployables`
- `links a compose service with a build context to its component`
- `maps a postgres image to the postgres capability`
- `ignores a compose file that is not valid YAML rather than failing the analysis`
- `reads ports from a compose service rather than the union of every EXPOSE`
- `reports a version 1 profile as outdated`

### Performance Budget

Analysis of a repository with 120 manifests, 20 Dockerfiles and 8 compose files completes in under
15 s and holds no working copy on disk. Blob fetches run at most 8 concurrently so a large monorepo
does not exhaust the GitHub rate limit in one run.

### Out of Scope

- Any change to `proposeArchitecture`; it keeps reading the profile as it does today
- Kubernetes manifests and Helm charts, which are a separate signal source
- Parsing source files, symbol graphs, embeddings -- all engine work
- Backfilling stored version 1 profiles; the UI offers a re-run instead

### Dependencies

Blocked by #47.

### Verification

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines, and splitting compose parsing from attribution would leave the profile
inconsistent between two merges
