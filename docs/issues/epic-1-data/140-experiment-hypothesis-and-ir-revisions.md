---
title: '[db] Experiment hypothesis, verdict, and an append-only IR revision chain'
labels: tier:2, size:m, area:db, epic:1-data
---

### Epic

#2

### Context

Nothing the product produces is currently an object a user can return to. `analyses` records what a
repository is, and `apps/web/src/pages/RepositoryPage.tsx` calls `proposeArchitecture` in a `useMemo`
and throws the result away on unmount. The only architecture that survives a page reload is the one
in `localStorage` under `infracanvas-designer-v1`, which belongs to no repository, has no history,
and cannot be compared with anything. The user's actual question -- "is Aurora Serverless cheaper
than RDS for _this_ application" -- needs two saved architectures over one repository and a way to
put them side by side.

An experiment is that object: a repository, a named hypothesis, an ordered history of Architecture
IR revisions, the predictions computed for each revision, an optional deployment, the measurements a
load test returned, and a verdict. #27 already specifies an `experiments` table, but with a single
mutable `ir jsonb` column. That is enough to deploy an architecture once and not enough for anything
this epic is for: an edit overwrites the document that was priced, a copilot edit is
indistinguishable from a human one, and there is no revision to fork from. This issue adds the
history and the fields that make an experiment a hypothesis rather than a drawing.

**A forward migration on top of #27 rather than an edit to it.** #27 is referenced by issue number
from #71, #72, #111 and #113, and its migration may already have been applied by the time this lands.
Rewriting an applied migration is not reviewable and not reversible, and `db/migrations/` is append
only by convention -- every existing file there is additive. So this issue ships a second migration
that alters `experiments`, creates `experiment_revisions`, backfills revision 1 from the `ir` column,
and only then drops it. The drop is destructive DDL and needs the `db:destructive-approved` label to
pass Gate 4; leaving `experiments.ir` in place instead was rejected because two writable copies of
the same document is exactly the defect this issue exists to remove.

**A revision stores the whole IR document, not a patch.** The two readers decide this. The comparison
view holds two arbitrary revisions from two different experiments at once, and the copilot needs one
complete `ArchitectureIr` to reason over before it can propose anything; neither ever wants "the
state at seq 7" reconstructed. With whole documents each of those reads is one indexed row. With a
patch chain each is O(depth) rows plus a replay in the API before either consumer can start, and the
replay has to be correct in TypeScript and again in Python for `services/brain`. Storage does not
argue the other way: `docs/issues/epic-2-ir/010-architecture-ir-schema.md` budgets a 500-node
document, which is tens of kilobytes, jsonb is TOASTed and compressed, and a hundred revisions of a
large architecture is single-digit megabytes for one experiment. The decisive point is correctness --
under a patch chain every historical read depends on every patch before it, so one bad patch silently
rewrites history, and an append-only log whose contents change is not a log.

The patch is still recorded, as an RFC 6902 operation array alongside the document, because the
timeline needs "what changed" per revision and the copilot needs to show its own edit as a diff;
recomputing that from two whole documents at read time is more work than storing the array the editor
already had in hand. It is derived data and never the authority: where they disagree the document
wins, and a test asserts that applying a revision's patch to its parent reproduces its document
exactly.

Spec: `docs/DATABASE.md`, `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```sql
-- migrate:up

CREATE TYPE experiment_verdict AS ENUM ('undecided', 'adopt', 'reject', 'inconclusive');

ALTER TABLE experiments
  -- What this experiment is testing, in the user's words. Required at creation
  -- rather than nullable: an experiment with no hypothesis is a drawing, and the
  -- comparison view has nothing to title its two columns with.
  ADD COLUMN hypothesis text NOT NULL DEFAULT '',
  -- Cross-experiment lineage lives here rather than on the revision chain, so a
  -- revision's parent is always inside its own experiment and the chain stays a
  -- chain. Both are nullable: an experiment created from a proposal has no origin.
  ADD COLUMN forked_from_experiment_id uuid REFERENCES experiments (id) ON DELETE SET NULL,
  ADD COLUMN forked_from_revision_id   uuid,
  ADD COLUMN head_revision_id          uuid,
  ADD COLUMN archived_at               timestamptz,
  ADD COLUMN verdict      experiment_verdict NOT NULL DEFAULT 'undecided',
  ADD COLUMN verdict_note text,
  ADD COLUMN verdict_at   timestamptz,
  -- A verdict with no reason and no date is a badge rather than a result: six
  -- months later nobody can tell whether "reject" meant too expensive or too slow.
  ADD CONSTRAINT experiments_verdict_reasoned_ck CHECK (
    (verdict = 'undecided' AND verdict_note IS NULL AND verdict_at IS NULL)
    OR (verdict <> 'undecided' AND verdict_note IS NOT NULL AND verdict_at IS NOT NULL)
  ),
  ADD CONSTRAINT experiments_hypothesis_len_ck CHECK (length(hypothesis) <= 500);

ALTER TABLE experiments ALTER COLUMN hypothesis DROP DEFAULT;

CREATE TYPE ir_revision_author AS ENUM ('human', 'copilot', 'system');

-- What produced this revision. `system` covers the deterministic proposal and the
-- fork copy; `copilot` is Epic 13 (#117). Kept apart from author_kind because a
-- human accepting a copilot suggestion is a human-authored copilot_patch, and the
-- timeline has to be able to say so.
CREATE TYPE ir_revision_source AS ENUM (
  'proposal', 'canvas_edit', 'copilot_patch', 'fork', 'import', 'revert'
);

-- The append-only history of one experiment's architecture.
--
-- Each row carries the complete Architecture IR document as of that revision.
-- See this issue's Context for why this is not a patch chain: the comparison view
-- and the copilot both read arbitrary revisions whole, and a log whose historical
-- contents depend on replaying every earlier row is not a log.
CREATE TABLE experiment_revisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  -- Dense and 1-based per experiment, so the timeline can label revisions without
  -- reading the whole chain and a URL can name one.
  seq           integer NOT NULL,
  parent_id     uuid,
  -- The whole ArchitectureIr, validated against packages/ir-schema (#77) by the
  -- application before insert. The database checks only that it is an object,
  -- because a CHECK cannot run the reference rules the validator does.
  ir            jsonb NOT NULL,
  ir_version    text  NOT NULL,
  -- RFC 6902 operations taking the parent document to this one. Derived data kept
  -- for the timeline and the copilot diff; the document above is the authority.
  -- Null on the first revision of an experiment, which has no parent.
  patch         jsonb,
  -- One line the timeline shows, e.g. "Swap RDS for Aurora Serverless v2".
  summary       text  NOT NULL,
  source        ir_revision_source NOT NULL,
  author_kind   ir_revision_author NOT NULL,
  author_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Provider, model, and brain run id for a copilot edit, so a suggestion can be
  -- traced back to the run that made it. Never set for a human edit.
  author_agent  text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (experiment_id, seq),
  -- Redundant on its own, and required so the composite foreign key below can
  -- reference it. That key is what stops a revision naming a parent in a
  -- different experiment, which no single-column reference can express.
  UNIQUE (experiment_id, id),
  FOREIGN KEY (experiment_id, parent_id)
    REFERENCES experiment_revisions (experiment_id, id) ON DELETE RESTRICT,

  CONSTRAINT experiment_revisions_seq_ck    CHECK (seq > 0),
  -- Exactly the first revision is a root. A later revision with no parent would
  -- be an orphan the timeline cannot place.
  CONSTRAINT experiment_revisions_root_ck   CHECK ((seq = 1) = (parent_id IS NULL)),
  CONSTRAINT experiment_revisions_self_ck   CHECK (parent_id <> id),
  CONSTRAINT experiment_revisions_ir_ck     CHECK (jsonb_typeof(ir) = 'object'),
  CONSTRAINT experiment_revisions_patch_ck  CHECK (patch IS NULL OR jsonb_typeof(patch) = 'array'),
  CONSTRAINT experiment_revisions_summary_ck CHECK (length(summary) BETWEEN 1 AND 200),
  -- A human edit names the user; a copilot edit names the agent. Both are
  -- enforced here so "who changed this" is answerable from the row alone.
  CONSTRAINT experiment_revisions_human_ck
    CHECK ((author_kind = 'human') = (author_user_id IS NOT NULL)),
  CONSTRAINT experiment_revisions_agent_ck
    CHECK ((author_kind = 'copilot') = (author_agent IS NOT NULL))
);

-- experiments.head_revision_id points into a table that references experiments, so
-- the two rows are inserted in the same transaction and the constraint can only be
-- satisfied at commit. RESTRICT rather than CASCADE: dropping an experiment removes
-- its own row first, so the cascade to its revisions is unaffected, but nothing may
-- delete the head revision on its own.
ALTER TABLE experiments
  ADD CONSTRAINT experiments_head_revision_fk
    FOREIGN KEY (head_revision_id) REFERENCES experiment_revisions (id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- Append-only, enforced by the database rather than by convention.
--
-- UPDATE only. A BEFORE DELETE trigger cannot distinguish a direct delete from the
-- cascade fired when the owning experiment is removed without depending on the
-- order Postgres applies referential actions in, and deleting an experiment is the
-- one delete that is meant to reach these rows.
CREATE OR REPLACE FUNCTION reject_revision_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'experiment_revisions is append-only; revision % may not be updated', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experiment_revisions_append_only
  BEFORE UPDATE ON experiment_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_revision_update();

-- Read paths, and only read paths.
--
-- The timeline reads (experiment_id, seq DESC) and is already served by the
-- UNIQUE (experiment_id, seq) index, so no second index is created for it.
--
-- The experiments list is scoped to a user and filtered to one repository when the
-- user opens a repository, and never shows archived rows.
CREATE INDEX experiments_user_repository_idx
  ON experiments (user_id, repository_id, created_at DESC)
  WHERE archived_at IS NULL;

-- "What was forked from this" on the experiment header. Partial because almost
-- every experiment has a null origin.
CREATE INDEX experiments_forked_from_idx
  ON experiments (forked_from_experiment_id)
  WHERE forked_from_experiment_id IS NOT NULL;

-- Backfill before dropping, so a database where #27 already holds rows keeps its
-- architectures. `ir_version` is preserved as recorded; no document is rewritten.
INSERT INTO experiment_revisions
  (experiment_id, seq, parent_id, ir, ir_version, patch, summary, source, author_kind, author_user_id)
SELECT e.id, 1, NULL, e.ir, e.ir_version, NULL, 'Imported from the experiment record',
       'import', 'system', NULL
  FROM experiments e
 WHERE jsonb_typeof(e.ir) = 'object';

UPDATE experiments e
   SET head_revision_id = r.id
  FROM experiment_revisions r
 WHERE r.experiment_id = e.id AND r.seq = 1;

ALTER TABLE experiments DROP COLUMN ir, DROP COLUMN ir_version;

-- migrate:down

ALTER TABLE experiments
  ADD COLUMN ir jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN ir_version text NOT NULL DEFAULT '0.0.0';

UPDATE experiments e
   SET ir = r.ir, ir_version = r.ir_version
  FROM experiment_revisions r
 WHERE r.id = e.head_revision_id;

ALTER TABLE experiments DROP CONSTRAINT experiments_head_revision_fk;

DROP TRIGGER IF EXISTS experiment_revisions_append_only ON experiment_revisions;
DROP FUNCTION IF EXISTS reject_revision_update();
DROP TABLE IF EXISTS experiment_revisions;
DROP TYPE IF EXISTS ir_revision_source;
DROP TYPE IF EXISTS ir_revision_author;

DROP INDEX IF EXISTS experiments_forked_from_idx;
DROP INDEX IF EXISTS experiments_user_repository_idx;

ALTER TABLE experiments
  DROP CONSTRAINT experiments_hypothesis_len_ck,
  DROP CONSTRAINT experiments_verdict_reasoned_ck,
  DROP COLUMN verdict_at,
  DROP COLUMN verdict_note,
  DROP COLUMN verdict,
  DROP COLUMN archived_at,
  DROP COLUMN head_revision_id,
  DROP COLUMN forked_from_revision_id,
  DROP COLUMN forked_from_experiment_id,
  DROP COLUMN hypothesis;

DROP TYPE IF EXISTS experiment_verdict;
```

The data access module follows `apps/api/src/lib/db/repositories.ts` exactly: a snake_case row
interface, a `to*` mapper, the shared `UUID_PATTERN` guard so a malformed id from a URL reads as "not
found" rather than a query error, and `userId` as the first argument of every lookup rather than a
check the caller performs afterwards.

```typescript
// apps/api/src/lib/db/experiment-revisions.ts
import type { ArchitectureIr } from '@infracanvas/ir-schema';

export type IrRevisionAuthor = 'human' | 'copilot' | 'system';
export type IrRevisionSource =
  | 'proposal'
  | 'canvas_edit'
  | 'copilot_patch'
  | 'fork'
  | 'import'
  | 'revert';

/** RFC 6902. Structural only; `value` is whatever the IR holds at that pointer. */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  from?: string;
  value?: unknown;
}

export interface ExperimentRevision {
  id: string;
  experimentId: string;
  seq: number;
  parentId: string | null;
  ir: ArchitectureIr;
  irVersion: string;
  patch: JsonPatchOperation[] | null;
  summary: string;
  source: IrRevisionSource;
  authorKind: IrRevisionAuthor;
  authorUserId: string | null;
  authorAgent: string | null;
  createdAt: Date;
}

/** Everything the timeline draws, with the document left in the database. */
export type RevisionSummary = Omit<ExperimentRevision, 'ir' | 'patch'> & {
  /** Operation count, so the timeline can size a change without reading it. */
  patchOps: number;
};

export interface AppendRevisionInput {
  experimentId: string;
  /** Must be the current head. Null only for the first revision of an experiment. */
  parentId: string | null;
  ir: ArchitectureIr;
  irVersion: string;
  /** Computed from parent to child when omitted. Never trusted over `ir`. */
  patch?: JsonPatchOperation[];
  summary: string;
  source: IrRevisionSource;
  authorKind: IrRevisionAuthor;
  authorUserId?: string | null;
  authorAgent?: string | null;
}

/** Raised when `parentId` is not the experiment's head, so the caller can answer 409. */
export class RevisionConflictError extends Error {
  readonly headRevisionId: string | null;
}

/**
 * Append one revision and move the head, in a single transaction.
 *
 * `userId` scopes the experiment lookup, so no caller can extend another
 * account's chain by guessing an experiment id.
 */
export function appendRevision(
  userId: string,
  input: AppendRevisionInput
): Promise<ExperimentRevision>;

export function findRevision(
  userId: string,
  experimentId: string,
  revisionId: string
): Promise<ExperimentRevision | null>;

/** Newest first. Never selects `ir`; the timeline reads hundreds of these. */
export function listRevisions(
  userId: string,
  experimentId: string,
  limit?: number
): Promise<RevisionSummary[]>;

export function headRevision(
  userId: string,
  experimentId: string
): Promise<ExperimentRevision | null>;

/** The two documents a comparison needs, in one round trip and one ownership check. */
export function findRevisionPair(
  userId: string,
  a: { experimentId: string; revisionId: string },
  b: { experimentId: string; revisionId: string }
): Promise<{ a: ExperimentRevision; b: ExperimentRevision } | null>;
```

```typescript
// apps/api/src/lib/db/experiments.ts -- added to the module #27 creates
export type ExperimentVerdict = 'undecided' | 'adopt' | 'reject' | 'inconclusive';

export interface Experiment {
  // ... the fields #27 defines, less `ir` and `irVersion` ...
  hypothesis: string;
  headRevisionId: string | null;
  forkedFromExperimentId: string | null;
  forkedFromRevisionId: string | null;
  verdict: ExperimentVerdict;
  verdictNote: string | null;
  verdictAt: Date | null;
  archivedAt: Date | null;
}

export function findExperiment(userId: string, id: string): Promise<Experiment | null>;
export function listExperiments(
  userId: string,
  filter?: { repositoryId?: string; includeArchived?: boolean }
): Promise<Experiment[]>;
export function renameExperiment(
  userId: string,
  id: string,
  fields: { name?: string; hypothesis?: string }
): Promise<Experiment | null>;
/** Sets note and timestamp together; the CHECK refuses a verdict without them. */
export function recordVerdict(
  userId: string,
  id: string,
  verdict: ExperimentVerdict,
  note: string
): Promise<Experiment | null>;
```

Every function above takes `userId` first and folds it into the SQL predicate. `experiment_revisions`
has no `user_id` column and is not meant to grow one: a revision is reached only through its
experiment, and the join `WHERE r.experiment_id = $1 AND e.user_id = $2` is the single scoping rule
every read path carries. There is deliberately no exported function that accepts a revision id
without an experiment id and a user id.

### Files

- CREATE `db/migrations/<timestamp>_experiment_revisions.sql`
- CREATE `apps/api/src/lib/db/experiment-revisions.ts`
- CREATE `apps/api/src/lib/db/experiment-revisions.integration.test.ts`
- CREATE `apps/api/src/lib/db/json-patch.ts` - compute and apply RFC 6902 operations over the IR
- CREATE `apps/api/src/lib/db/json-patch.test.ts`
- MODIFY `apps/api/src/lib/db/experiments.ts` - hypothesis, fork lineage, head, verdict; drop `ir`
- MODIFY `apps/api/src/lib/db/experiments.integration.test.ts` - the cases below
- MODIFY `apps/api/package.json` - add `fast-json-patch` for the operation algebra

### Acceptance Criteria

- [ ] The migration applies, rolls back, and reapplies against a database holding experiments with a non-empty `ir` column, and no document is lost in either direction
- [ ] After the migration every pre-existing experiment has exactly one revision at `seq` 1 with `source: 'import'`, and `head_revision_id` points at it
- [ ] `experiments.ir` and `experiments.ir_version` no longer exist, so no code path can write an architecture outside the chain
- [ ] An `UPDATE` against any column of `experiment_revisions` raises rather than succeeding
- [ ] Deleting an experiment deletes its revisions; deleting a user deletes both
- [ ] A revision whose `parent_id` belongs to a different experiment is rejected by the database, not by application code
- [ ] A revision with `seq` greater than 1 and a null `parent_id` is rejected, and a revision with `seq` 1 and a parent is rejected
- [ ] A revision with `author_kind: 'human'` and no `author_user_id` is rejected, and one with `author_kind: 'copilot'` and no `author_agent` is rejected
- [ ] `appendRevision` with a `parentId` that is not the current head raises `RevisionConflictError` carrying the head id, and writes no row
- [ ] Applying a revision's stored `patch` to its parent's `ir` produces its own `ir` exactly, for every revision the module writes
- [ ] A verdict other than `undecided` cannot be stored without a note and a timestamp
- [ ] `listRevisions` returns rows without the `ir` payload, verified by asserting the selected column list rather than by inspecting the result size
- [ ] Every exported read takes `userId` and returns null for an experiment belonging to another user, rather than throwing or returning a permission error

### Required Tests

- `backfills one imported revision per existing experiment`
- `rolls back by restoring the head document into the ir column`
- `refuses to update a revision row`
- `cascades revision deletion from the experiment and from the user`
- `rejects a parent revision belonging to another experiment`
- `rejects a non-root revision with no parent`
- `rejects a root revision that names a parent`
- `rejects a human revision with no user and a copilot revision with no agent`
- `raises a conflict when the parent is not the head and leaves the chain unchanged`
- `reproduces the child document by applying the stored patch to the parent`
- `refuses a verdict with no note`
- `omits the ir document from the timeline query`
- `returns null for an experiment belonging to another user`
- `appends concurrently from two callers and lets exactly one succeed`

### Performance Budget

`listRevisions` over an experiment with 200 revisions completes in under 15ms and reads no `ir`
column, served by `UNIQUE (experiment_id, seq)` rather than a sequential scan, asserted with `EXPLAIN`
in the integration test. `findRevisionPair` is a single query returning two rows. `appendRevision`
completes in under 25ms for a 500-node document, which is one insert plus one update inside one
transaction.

### Out of Scope

- Do not build the REST surface; that is `docs/issues/epic-11-web/050-experiment-rest-api.md`
- Do not validate `ir` against the IR schema in the database. The application calls `validateIr` from
  #77 before insert, and a CHECK cannot run the reference rules that validator applies
- Do not add prediction, cost, or measured-SLI columns. Those are computed from a revision and
  cached by their own epics (#8, #11), not stored on the revision
- Do not change `deployments` or `artifacts` from #27; they hang off the experiment and are unaffected
- Do not implement forking, which is a route-level operation over these functions
- Do not add a `user_id` column to `experiment_revisions` to shorten the join

### Dependencies

Blocked by #27 for the `experiments` table this migration alters, and by #77 for the
`ArchitectureIr` type the module imports.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm lint && pnpm typecheck
pnpm --filter @infracanvas/api test
pnpm --filter @infracanvas/api test:integration
psql "$DATABASE_URL" -c "\d+ experiment_revisions"
psql "$DATABASE_URL" -c "UPDATE experiment_revisions SET summary = 'x'"   # must fail
psql "$DATABASE_URL" -c "EXPLAIN SELECT id, seq FROM experiment_revisions WHERE experiment_id = gen_random_uuid() ORDER BY seq DESC"
```

The pull request must carry `db:destructive-approved`, because dropping `experiments.ir` is
destructive DDL that Gate 4 blocks by default. The backfill above is what makes the drop safe, and
the reviewer should read those two statements together.

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
