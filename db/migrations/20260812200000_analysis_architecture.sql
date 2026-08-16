-- migrate:up

-- The architecture proposed from an analysis, stored beside the profile it was
-- derived from.
--
-- Synthesis is deterministic, so the proposal could be recomputed on every read
-- instead. It is stored because the decisions are the valuable part: each one
-- carries the rationale and the repository paths it rests on, and a user who
-- rejects a suggestion is disagreeing with a specific claim made about a
-- specific commit. Recomputing discards that record the moment the rules change,
-- which would silently rewrite the reasoning the user was shown.
--
-- Nullable rather than defaulted: a run that failed never produced a proposal,
-- and a run that succeeded before this column existed has a profile but no
-- stored proposal. Both are honestly represented by null.
ALTER TABLE analyses ADD COLUMN architecture jsonb;

-- migrate:down

ALTER TABLE analyses DROP COLUMN IF EXISTS architecture;
