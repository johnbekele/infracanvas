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

-- The update above leaves the deferred head-revision check pending until commit,
-- and Postgres refuses to ALTER a table that has pending trigger events, so the
-- drop below would fail on any database where the backfill actually moved a row.
-- Forcing the check now settles it: the rows it validates were just inserted in
-- this same transaction, so there is nothing it can reject.
SET CONSTRAINTS experiments_head_revision_fk IMMEDIATE;

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
