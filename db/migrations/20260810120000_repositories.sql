-- migrate:up

-- A repository a user has connected for analysis.
--
-- Owner and name are stored separately rather than as one "owner/name" string
-- because every GitHub API call needs them apart, and splitting on a slash at
-- each call site is how one of them eventually ends up with a stray space.
--
-- The GitHub numeric id is recorded alongside them so a renamed or transferred
-- repository can be recognised as the same one. Names are not stable; ids are.
CREATE TABLE repositories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  github_id      bigint      NOT NULL,
  github_owner   text        NOT NULL,
  github_name    text        NOT NULL,
  default_branch text        NOT NULL,
  is_private     boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Scoped to the user, not global: two people may each connect the same public
  -- repository, and each gets their own row and their own analyses.
  UNIQUE (user_id, github_owner, github_name)
);

CREATE INDEX repositories_user_idx ON repositories (user_id, created_at DESC);

CREATE TRIGGER repositories_set_updated_at
  BEFORE UPDATE ON repositories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down

DROP TABLE IF EXISTS repositories;
