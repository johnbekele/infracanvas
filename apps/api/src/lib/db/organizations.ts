// Organizations and workspaces: the two levels of tenancy.
//
// An organization owns billing, the plan and audit retention. A workspace is the
// isolation boundary -- every tenant row will carry workspace_id, and every
// row-level security policy will compare against it. organization_id lives only
// on workspaces, so no row can disagree with itself about which organization it
// belongs to.
import { query, withTransaction } from './client.js';

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

interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  plan: string;
  monthly_budget_usd: string;
  audit_retention_days: number;
  created_at: Date;
}

interface WorkspaceRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  created_at: Date;
}

/**
 * `numeric` arrives as a string, because a Postgres numeric can hold values no
 * IEEE double can represent and node-postgres refuses to lose digits silently.
 * A monthly budget in dollars at two decimal places is far inside Number's exact
 * range, so the conversion here is safe and keeps the field arithmetic-ready.
 */
function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind as Organization['kind'],
    plan: row.plan,
    monthlyBudgetUsd: Number(row.monthly_budget_usd),
    auditRetentionDays: row.audit_retention_days,
    createdAt: row.created_at,
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
  };
}

/**
 * Ids reach these functions from URLs and from request context, so they are not
 * necessarily uuids. Postgres rejects a malformed one as a query error, which
 * would surface as a server fault for what is really a request for something
 * that cannot exist. Checking the shape first turns that into an ordinary
 * "not found".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORGANIZATION_COLUMNS =
  'id, slug, name, kind, plan, monthly_budget_usd, audit_retention_days, created_at';

const WORKSPACE_COLUMNS = 'id, organization_id, slug, name, created_at';

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  kind: 'personal' | 'team';
  createdByUserId: string;
  workspace: { name: string; slug: string };
}

/**
 * Create an organization and its first workspace in one transaction. A personal
 * organization with no workspace is a state no caller can do anything with, so
 * it is never persisted.
 */
export async function createOrganization(
  input: CreateOrganizationInput
): Promise<{ organization: Organization; workspace: Workspace }> {
  return withTransaction(async (client) => {
    const organizationResult = await client.query<OrganizationRow>(
      `INSERT INTO organizations (slug, name, kind, created_by_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${ORGANIZATION_COLUMNS}`,
      [input.slug, input.name, input.kind, input.createdByUserId]
    );

    const organizationRow = organizationResult.rows[0];
    if (!organizationRow) throw new Error('Failed to create organization');

    const workspaceResult = await client.query<WorkspaceRow>(
      `INSERT INTO workspaces (organization_id, slug, name, created_by_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${WORKSPACE_COLUMNS}`,
      [organizationRow.id, input.workspace.slug, input.workspace.name, input.createdByUserId]
    );

    const workspaceRow = workspaceResult.rows[0];
    if (!workspaceRow) throw new Error('Failed to create workspace');

    return {
      organization: toOrganization(organizationRow),
      workspace: toWorkspace(workspaceRow),
    };
  });
}

/**
 * `lower(slug)` rather than `slug` so the lookup uses organizations_slug_idx,
 * which is a functional index on the lowercased value. `deleted_at IS NULL`
 * matches the index predicate as well as expressing the intent: a soft-deleted
 * organization has released its slug and must not answer to it.
 */
export async function findOrganizationBySlug(slug: string): Promise<Organization | null> {
  const result = await query<OrganizationRow>(
    `SELECT ${ORGANIZATION_COLUMNS} FROM organizations
     WHERE lower(slug) = lower($1) AND deleted_at IS NULL`,
    [slug]
  );
  return result.rows[0] ? toOrganization(result.rows[0]) : null;
}

/**
 * Oldest first, so the workspace the organization was created with leads the
 * list. Slug breaks ties, because two workspaces created in the same transaction
 * share a timestamp and an unordered list reshuffles a workspace switcher
 * between requests.
 */
export async function listWorkspaces(organizationId: string): Promise<Workspace[]> {
  if (!UUID_PATTERN.test(organizationId)) return [];

  const result = await query<WorkspaceRow>(
    `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
     WHERE organization_id = $1 AND deleted_at IS NULL
     ORDER BY created_at, slug`,
    [organizationId]
  );
  return result.rows.map(toWorkspace);
}

/**
 * Runs on every authenticated request once workspace routing lands, so it must
 * stay a single probe of workspaces_slug_idx: the predicates below are exactly
 * that index's columns and its partial condition.
 */
export async function findWorkspaceBySlug(
  organizationId: string,
  slug: string
): Promise<Workspace | null> {
  if (!UUID_PATTERN.test(organizationId)) return null;

  const result = await query<WorkspaceRow>(
    `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
     WHERE organization_id = $1 AND lower(slug) = lower($2) AND deleted_at IS NULL`,
    [organizationId, slug]
  );
  return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

/**
 * Soft delete, so the slug is freed for reuse while the rows beneath the
 * workspace keep a workspace_id that still resolves. A hard delete would either
 * orphan them or cascade into records naming cloud resources that are still
 * running; both are worse than a tombstone.
 *
 * Idempotent by construction: deleting an already-deleted or absent workspace
 * updates nothing and is not an error, because the caller's intent is satisfied
 * either way.
 */
export async function softDeleteWorkspace(id: string): Promise<void> {
  if (!UUID_PATTERN.test(id)) return;

  await query('UPDATE workspaces SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [
    id,
  ]);
}
