---
title: '[db] Organizations and workspaces, with the workspace as the isolation boundary'
labels: tier:1, size:m, area:db, epic:15-tenancy
---

### Epic

Epic 15, tenancy and access control. Its tracking issue is created by
`docs/issues/epic-0-delivery/240-the-backlog-can-be-recreated-from-the-repository.md` (Epic #1);
replace this line with `#N` once that has run.

### Context

Every table in the schema uses `user_id` as its tenancy boundary. `repositories`, `analyses` through
its repository, `llm_credentials`, `user_settings` and `sessions` all hang off a user, and every query
in `apps/api/src/lib/db/` scopes by one. There is no organization, no workspace, no team, no
membership and no role. Two people cannot see the same repository, and one person cannot separate
their own work into environments that are governed differently.

`docs/issues/ROADMAP.md` puts this first in Phase 1 for a mechanical reason: every issue after it
references `workspace_id` in its Contract. A spec written before the column exists has to be rewritten
after; a spec written after it exists is written once.

**Two levels, not one and not three.** An `organization` owns billing, the plan, audit retention and
organization-wide policy. A `workspace` is the isolation boundary — every tenant row carries
`workspace_id`, and every row-level security policy compares against it. Projects, architectures,
experiments and deployments live inside a workspace.

A third level was considered and rejected. Teams that group members inside a workspace are a
permissions convenience, and they can be added later as a grouping over `workspace_members` without
moving the boundary. Moving the boundary later is a migration of every table.

**A solo user gets an organization too.** `kind = 'personal'` marks it, and nothing else about it is
special: one member, one workspace, the same policies and the same code path. The alternative —
nullable `organization_id` meaning "just me" — puts a branch in every query and every policy, and the
branch that is rarely exercised is the one that leaks.

**`organization_id` lives only on `workspaces`.** Denormalising it onto every leaf table would make
the policies marginally cheaper and would invite exactly one bug: a row whose `workspace_id` and
`organization_id` disagree. The request context resolves workspace to organization once, on the way
in.

Two DDL decisions are worth stating because they are the reversibility of the whole migration
sequence, and Gate 4 runs `dbmate up`, `rollback`, `up` on every pull request.

**No Postgres `ENUM` for a value set that will grow.** `ALTER TYPE ... ADD VALUE` has no inverse; to
roll it back you recreate the type and rewrite every dependent column, which is destructive DDL inside
`migrate:down` and fails the round trip. The existing schema uses enums freely — `analysis_status` is
one — and this migration does not, using `text` with a `CHECK` instead. That is a policy this issue
introduces and `docs/DATABASE.md` records.

**`ON DELETE RESTRICT` from workspace to organization.** A cascade would let one `DELETE` remove an
organization, its workspaces, and eventually every experiment and deployment record beneath them —
including the rows naming AWS stacks that are still running and still billing. Deleting an
organization has to be a workflow that destroys cloud resources and settles accounts, so the database
refuses the shortcut.

Spec: `docs/issues/ROADMAP.md`

### Contract

```sql
-- db/migrations/<timestamp>_tenancy_core.sql
-- migrate:up

CREATE TABLE organizations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- 'personal' is not a lesser organization. It is an organization with one
  -- member, so that there is exactly one code path rather than two.
  kind                 text NOT NULL DEFAULT 'personal'
                         CHECK (kind IN ('personal', 'team')),
  -- Plans gate limits, never features. A plan that gates features multiplies
  -- code paths; a plan that gates numbers multiplies numbers.
  plan                 text NOT NULL DEFAULT 'free',
  monthly_budget_usd   numeric(12,2) NOT NULL DEFAULT 0 CHECK (monthly_budget_usd >= 0),
  audit_retention_days integer NOT NULL DEFAULT 365
                         CHECK (audit_retention_days BETWEEN 30 AND 3650),
  created_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

-- Partial, so a deleted slug can be reused.
CREATE UNIQUE INDEX organizations_slug_idx
  ON organizations (lower(slug)) WHERE deleted_at IS NULL;

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workspaces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, not CASCADE: see the Context. Deleting an organization must be a
  -- workflow that destroys cloud resources, not a DELETE that orphans running
  -- stacks nobody can find again.
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  slug               text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

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
```

`set_updated_at()` already exists, created by `db/migrations/20260809120000_core_identity.sql`, which
states why it is database-side: three languages write this schema.

```typescript
// apps/api/src/lib/db/organizations.ts
export interface Organization {
  id: string;
  slug: string;
  name: string;
  kind: 'personal' | 'team';
  plan: string;
  monthlyBudgetUsd: number;
  auditRetentionDays: number;
  createdAt: Date;
}

export interface Workspace {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  createdAt: Date;
}

/**
 * Create an organization and its first workspace in one transaction. A personal
 * organization with no workspace is a state no caller can do anything with, so
 * it is never persisted.
 */
export function createOrganization(input: {
  name: string;
  slug: string;
  kind: 'personal' | 'team';
  createdByUserId: string;
  workspace: { name: string; slug: string };
}): Promise<{ organization: Organization; workspace: Workspace }>;

export function findOrganizationBySlug(slug: string): Promise<Organization | null>;
export function listWorkspaces(organizationId: string): Promise<Workspace[]>;
export function findWorkspaceBySlug(
  organizationId: string,
  slug: string
): Promise<Workspace | null>;
export function softDeleteWorkspace(id: string): Promise<void>;
```

### Files

- `db/migrations/<timestamp>_tenancy_core.sql` — CREATE: the DDL above, with a `migrate:down` that
  drops both tables.
- `apps/api/src/lib/db/organizations.ts` — CREATE: the repository functions above.
- `apps/api/src/lib/db/organizations.test.ts` — CREATE: the cases below.
- `docs/DATABASE.md` — MODIFY: record the two-level model, and the policy that new value sets use
  `text` with a `CHECK` rather than a Postgres `ENUM`, with the rollback reasoning.

### Acceptance Criteria

- [ ] `dbmate up`, `dbmate rollback` and `dbmate up` succeed in sequence with no manual intervention.
- [ ] Two organizations may hold workspaces with the same slug; one organization may not.
- [ ] A soft-deleted workspace frees its slug for reuse within the same organization.
- [ ] Deleting an organization that still has a workspace is refused by the database.
- [ ] `createOrganization` creates the organization and its first workspace atomically, and creates neither if either fails.
- [ ] `updated_at` advances on update without the application setting it.
- [ ] No new Postgres `ENUM` type is introduced by this migration.

### Required Tests

- `creates an organization and its first workspace atomically` — asserts both rows exist and share the
  organization id.
- `rolls back both when the workspace slug collides` — a failing second insert leaves no organization
  row, proving the transaction rather than two statements.
- `allows the same workspace slug in two organizations` — the uniqueness is scoped, not global.
- `refuses a duplicate workspace slug in one organization` — the partial unique index bites.
- `frees a slug when the workspace is soft deleted` — soft delete then recreate with the same slug
  succeeds, which is what makes the index partial rather than total.
- `refuses to delete an organization that still has a workspace` — asserts the `RESTRICT`, because a
  cascade here would orphan running infrastructure.
- `advances updated_at on update` — the trigger fires without the caller setting the column.
- `rejects a slug that is not url safe` — an uppercase or space-bearing slug is refused by the CHECK
  rather than normalised silently.
- `migration rolls back cleanly` — an integration test running `up`, `rollback`, `up` against the test
  database, which is what Gate 4 will run.

### Performance Budget

`findWorkspaceBySlug` runs on every authenticated request once workspace routing lands, so it must be
a single index probe: under 1 ms at 10,000 workspaces. `docs/DELIVERY.md` budgets API p99 under 100 ms
on non-AI routes, and this sits inside that.

### Out of Scope

- Memberships, roles and permissions. `020-roles-and-the-permission-matrix.md`.
- Row-level security. `030-row-level-security-and-the-tenant-wrapper.md`.
- Adding `workspace_id` to the existing tables or backfilling them.
  `040-move-the-existing-tables-into-a-workspace.md`.
- Invitations, API keys, the workspace switcher.
- Billing, plan enforcement, or any use of `monthly_budget_usd`, which is defined here and consumed in
  Phase 6.

### Dependencies

none

### Verification

```bash
pnpm db:up
pnpm db:migrate
pnpm db:rollback && pnpm db:migrate
pnpm --filter @infracanvas/api exec vitest run --config vitest.integration.config.ts src/lib/db/organizations.test.ts
```

Confirm the round trip Gate 4 performs, and that no enum type was added:

```bash
psql "$DATABASE_URL" -c "\dT+ public.*"
psql "$DATABASE_URL" -c "\d+ workspaces"
```
