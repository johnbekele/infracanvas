-- migrate:up

-- Two levels of tenancy, not one and not three.
--
-- An organization owns billing, the plan, audit retention and organization-wide
-- policy. A workspace is the isolation boundary: every tenant row will carry
-- workspace_id, and every row-level security policy will compare against it.
--
-- A third level -- teams grouping members inside a workspace -- was considered
-- and rejected. Teams are a permissions convenience and can be added later as a
-- grouping over workspace_members without moving the boundary. Moving the
-- boundary later is a migration of every table in the schema.
--
-- Note what this migration deliberately does not use: a Postgres ENUM. `kind`
-- and `plan` are value sets that will grow, and `ALTER TYPE ... ADD VALUE` has
-- no inverse -- undoing it means recreating the type and rewriting every
-- dependent column, which is destructive DDL inside migrate:down and fails the
-- up/rollback/up round trip Gate 4 runs. `text` with a CHECK is reversible by an
-- ordinary constraint drop. docs/DATABASE.md records this as policy.
CREATE TABLE organizations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                 text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- 'personal' is not a lesser organization. It is an organization with one
  -- member, so that there is exactly one code path rather than two. The
  -- alternative -- a nullable organization_id meaning "just me" -- puts a branch
  -- in every query and every policy, and the branch that is rarely exercised is
  -- the one that leaks.
  kind                 text        NOT NULL DEFAULT 'personal'
                         CHECK (kind IN ('personal', 'team')),
  -- Plans gate limits, never features. A plan that gates features multiplies
  -- code paths; a plan that gates numbers multiplies numbers.
  plan                 text        NOT NULL DEFAULT 'free',
  monthly_budget_usd   numeric(12,2) NOT NULL DEFAULT 0 CHECK (monthly_budget_usd >= 0),
  audit_retention_days integer     NOT NULL DEFAULT 365
                         CHECK (audit_retention_days BETWEEN 30 AND 3650),
  created_by_user_id   uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

-- Partial, so a deleted slug can be reused. lower(slug) rather than slug because
-- the CHECK already forbids uppercase; the functional index keeps the lookup and
-- the constraint agreeing even if that CHECK is ever relaxed.
CREATE UNIQUE INDEX organizations_slug_idx
  ON organizations (lower(slug)) WHERE deleted_at IS NULL;

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workspaces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, not CASCADE. A cascade would let one DELETE remove an
  -- organization, its workspaces, and eventually every experiment and deployment
  -- record beneath them -- including the rows naming AWS stacks that are still
  -- running and still billing. Deleting an organization has to be a workflow
  -- that destroys cloud resources and settles accounts, so the database refuses
  -- the shortcut.
  organization_id    uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  slug               text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name               text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

-- organization_id is not denormalised onto leaf tables. Doing so would make the
-- policies marginally cheaper and would invite exactly one bug: a row whose
-- workspace_id and organization_id disagree. The request context resolves
-- workspace to organization once, on the way in.
--
-- Scoped to the organization, not global: two organizations may each have a
-- workspace called 'production'. Partial, so a soft-deleted workspace frees its
-- slug for reuse. This index also serves findWorkspaceBySlug, which runs on
-- every authenticated request once workspace routing lands.
CREATE UNIQUE INDEX workspaces_slug_idx
  ON workspaces (organization_id, lower(slug)) WHERE deleted_at IS NULL;

CREATE INDEX workspaces_organization_idx
  ON workspaces (organization_id) WHERE deleted_at IS NULL;

CREATE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down

DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS organizations;
