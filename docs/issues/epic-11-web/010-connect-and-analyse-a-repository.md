---
title: '[web] Connect a repository, analyse it, and propose an architecture'
labels: tier:2, size:l, area:web, area:api, epic:11-ui
---

### Epic

#12

### Context

The product promise is that a user points at a repository and gets an architecture derived from what
that repository actually is. Today the only entry point is a blank canvas: the designer opens with an
empty grid and a palette, and nothing in the interface connects a repository to it at all. The
repository picker that does exist lives inside the push dialog and runs the other way -- it selects a
destination for generated code, not a subject for analysis.

This issue delivers the first end-to-end path: connect a repository, analyse it, read what the
analysis found, and open the resulting architecture on the canvas.

The analysis here is deterministic and reads only files that state facts about the application:
dependency manifests, Dockerfiles, and GitHub's language breakdown. It does not parse source, build a
symbol graph, or embed anything -- that is the ingest engine's work, and it is not a prerequisite for
a useful profile. A manifest saying `pg` is a fact about what the application connects to, and a
lookup table maps that fact to RDS. Nothing about that mapping is improved by asking a model, and a
hallucinated dependency here becomes a provisioned database.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TABLE repositories (
  id uuid PRIMARY KEY, user_id uuid REFERENCES users ON DELETE CASCADE,
  github_id bigint NOT NULL, github_owner text NOT NULL, github_name text NOT NULL,
  default_branch text NOT NULL, is_private boolean NOT NULL,
  UNIQUE (user_id, github_owner, github_name)
);

CREATE TABLE analyses (
  id uuid PRIMARY KEY, repository_id uuid REFERENCES repositories ON DELETE CASCADE,
  ref text NOT NULL, commit_sha text, status analysis_status NOT NULL,
  profile jsonb, error text
);
CREATE UNIQUE INDEX analyses_one_active_idx ON analyses (repository_id)
  WHERE status IN ('pending', 'running');
```

```typescript
// packages/core -- the shared contract between producer and consumers
export interface AppProfile {
  schemaVersion: 1;
  commitSha: string;
  languages: LanguageBreakdown[];
  components: Component[];
  dependencies: DetectedDependency[]; // each carries the path it was read from
  containerisation: Containerisation;
  notes: string[]; // limits hit, stated rather than hidden
}

export function proposeArchitecture(
  profile: AppProfile,
  repositoryName: string
): ArchitectureProposal;
```

```
GET    /repositories                          -> { repositories }
POST   /repositories             {owner,repo} -> { repository }        201
GET    /repositories/:id                      -> { repository }
DELETE /repositories/:id                      -> 204
GET    /repositories/:id/analyses             -> { analyses }
POST   /repositories/:id/analyses     {ref?}  -> { analysis }          201 | 409
```

### Files

- CREATE `db/migrations/*_repositories.sql`, `db/migrations/*_analyses.sql`
- CREATE `apps/api/src/lib/db/repositories.ts`, `apps/api/src/lib/db/analyses.ts`
- CREATE `apps/api/src/lib/analysis/{analyze,github-source,manifests,signatures}.ts`
- CREATE `apps/api/src/routes/repositories/{index,analyses}.ts`
- CREATE `packages/core/src/analysis/{profile,architecture}.ts`
- CREATE `apps/web/src/pages/{RepositoriesPage,RepositoryPage}.tsx`
- CREATE `apps/web/src/components/repositories/`, `apps/web/src/components/analysis/`
- DELETE `apps/web/src/components/github/GitHubSettingsDialog.tsx`, `apps/web/src/lib/github/{store,api}.ts`

### Acceptance Criteria

- [ ] Connecting the same repository twice yields one row, with details refreshed from GitHub
- [ ] Repository details come from the GitHub API, never from the request body
- [ ] A repository id belonging to another user reads as "not found", not as a permission error
- [ ] A second analysis started while one is running is refused with 409
- [ ] A failed analysis is recorded as `failed` rather than left `running`, so retry is possible
- [ ] Every detected dependency carries the manifest path it was read from
- [ ] An ORM yields no database node, because it does not name an engine
- [ ] A capability with no service in the catalog is reported as a gap, not silently dropped
- [ ] Every proposed node has a decision explaining it
- [ ] The proposal is deterministic for a given profile
- [ ] The initial JavaScript payload does not grow; the designer loads on demand

### Required Tests

- `upserts rather than duplicating a repository`
- `lets two users connect the same public repository`
- `does not return a repository belonging to another user`
- `reads dependency names from every supported manifest format`
- `maps a database driver to the engine it needs`
- `leaves the capability unset for an ORM`
- `matches a Go module past its major version suffix`
- `chooses ECS when the repository builds a container image`
- `reports MongoDB as a gap rather than substituting another database`
- `is deterministic: the same profile yields the same proposal`

### Performance Budget

Analysis of a repository the size of this one completes in under 5 s and holds no working copy on
disk. Initial web JavaScript stays within the Gate 6 budget.

### Out of Scope

- Parsing source files, symbol graphs, embeddings, retrieval -- all engine work
- Cost, latency, and SLO prediction for the proposed architecture
- Generating Pulumi code from the proposal or deploying it
- A background worker; analysis runs inline because it is a few HTTP calls

### Dependencies

Blocked by #22.

### Verification

```bash
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test:integration
pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
