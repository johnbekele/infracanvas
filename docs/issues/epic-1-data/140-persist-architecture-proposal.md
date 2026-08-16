---
title: '[db] Store the proposed architecture with the analysis that produced it'
labels: tier:2, size:m, area:db, area:api, area:web, epic:1-data
---

### Epic

#2

### Context

An analysis records its `profile` and nothing else. The architecture is synthesised in the browser,
inside a `useMemo` on the repository page, and thrown away on every navigation. Each proposal carries
the decisions behind it -- a rationale per node and the repository paths that rationale rests on --
and those are the part a user acts on: they accept a suggestion because they can see the Dockerfile
it came from, or reject it because they can see it came from a driver in a manifest they no longer
use.

Recomputing on read also makes the reasoning unstable. Synthesis is deterministic for a given
profile, but the rules change between releases, so the same stored analysis silently produces
different rationales over time. There is then no way to answer what was proposed for a commit, only
what would be proposed for it today.

Storing the proposal beside the profile fixes both, and is what later work needs anyway: an
experiment forks a proposal, and a copilot edit needs something to diff against.

Spec: `docs/DATABASE.md`

### Contract

```sql
-- Purely additive. `analyses` rows written before this exist and are valid.
ALTER TABLE analyses ADD COLUMN architecture jsonb;
```

```typescript
export interface Analysis {
  // ...existing fields
  /** The architecture synthesised from `profile`, or null when none was. */
  architecture: ArchitectureProposal | null;
}

/** Writes the profile and the proposal in one statement, so they cannot disagree. */
export function completeAnalysis(
  id: string,
  profile: AppProfile,
  architecture: ArchitectureProposal
): Promise<Analysis>;
```

The API synthesises the proposal when the analysis completes and returns it from
`GET /repositories/:id/analyses` and `GET /repositories/:id/analyses/:analysisId`. The web app reads
the stored proposal. Runs recorded before this column existed have `architecture: null`, and are
served from a proposal recomputed in the browser rather than being blanked.

### Files

- CREATE `db/migrations/<timestamp>_analysis_architecture.sql`
- MODIFY `apps/api/src/lib/db/analyses.ts` - carry and store the proposal
- MODIFY `apps/api/src/routes/repositories/analyses.ts` - synthesise on completion
- CREATE `apps/api/src/lib/db/analyses.integration.test.ts`
- CREATE `apps/web/src/lib/analysis/proposal.ts` - choose the stored proposal over a recomputed one
- CREATE `apps/web/src/lib/analysis/proposal.test.ts`
- MODIFY `apps/web/src/lib/api/repositories.ts` - the new field
- MODIFY `apps/web/src/pages/RepositoryPage.tsx` - read rather than recompute

### Acceptance Criteria

- [ ] The migration only adds a column, so it needs no destructive-DDL approval and no backfill
- [ ] The migration rolls back and reapplies cleanly
- [ ] A completed analysis stores the proposal with every decision, rationale, and evidence path
- [ ] The proposal survives a round trip through `jsonb` unchanged
- [ ] Every read path for an analysis returns the stored proposal
- [ ] A run that is still running, or that failed, reports a null architecture
- [ ] A failed retry does not blank the proposal from the last successful run
- [ ] The web app renders the stored proposal without recomputing it
- [ ] A run stored before this column existed still renders, from a recomputed proposal

### Required Tests

- `stores the proposed architecture alongside the profile`
- `keeps every decision, its rationale, and its evidence paths`
- `round-trips the proposal through jsonb without changing it`
- `serves the stored proposal to every later read of the run`
- `reports a null architecture for a failed run`
- `leaves an earlier stored proposal untouched when a later run fails`
- `returns the stored proposal with its rationale and evidence intact`
- `recomputes from the profile for a run stored before proposals were persisted`
- `prefers the stored proposal over recomputing it`

### Performance Budget

n/a - the proposal is synthesised once per analysis, inside work that already takes seconds of
GitHub round trips. Reading it back is one column of an existing row.

### Out of Scope

- Do not version the stored proposal or migrate old ones; a re-analysis replaces it
- Do not change synthesis itself, only where it runs and where its output is kept
- Do not backfill proposals for existing analyses; that would spend GitHub budget for pages nobody
  has asked for

### Dependencies

none

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm lint
pnpm turbo test
pnpm --filter @infracanvas/api test:integration
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
