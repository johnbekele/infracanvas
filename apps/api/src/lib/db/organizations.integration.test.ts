import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import {
  createOrganization,
  findOrganizationBySlug,
  findWorkspaceBySlug,
  listWorkspaces,
  softDeleteWorkspace,
} from './organizations.js';

const run = promisify(execFile);

async function makeUser(githubId = 1, username = 'octocat') {
  const user = await findOrCreateUser({
    githubId,
    githubUsername: username,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });
  return user.id;
}

/**
 * The organization contract exposes no createWorkspace -- the first workspace is
 * created with its organization, and adding further ones is a later issue. Tests
 * that need a second workspace insert one directly rather than inventing a
 * repository function this issue does not own.
 */
async function insertWorkspace(organizationId: string, slug: string, name = slug) {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO workspaces (organization_id, slug, name) VALUES ($1, $2, $3) RETURNING id`,
    [organizationId, slug, name]
  );
  return rows[0].id;
}

async function countOrganizations() {
  const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM organizations');
  return Number(rows[0].count);
}

beforeEach(async () => {
  // organizations and workspaces are listed explicitly because workspaces holds a
  // RESTRICT reference: truncating organizations alone is refused.
  await query('TRUNCATE workspaces, organizations, users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('createOrganization', () => {
  it('creates an organization and its first workspace atomically', async () => {
    const userId = await makeUser();

    const { organization, workspace } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    expect(organization.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(organization.slug).toBe('acme');
    expect(organization.kind).toBe('team');
    // Defaults come from the database, so every writer of this schema agrees on
    // them rather than each language carrying its own copy.
    expect(organization.plan).toBe('free');
    expect(organization.monthlyBudgetUsd).toBe(0);
    expect(organization.auditRetentionDays).toBe(365);

    expect(workspace.organizationId).toBe(organization.id);
    expect(workspace.slug).toBe('production');

    // Both rows are really there, not just returned.
    expect(await findOrganizationBySlug('acme')).not.toBeNull();
    expect(await listWorkspaces(organization.id)).toHaveLength(1);
  });

  it('defaults a solo user to a personal organization that is otherwise ordinary', async () => {
    const userId = await makeUser();

    const { organization, workspace } = await createOrganization({
      name: 'Octocat',
      slug: 'octocat',
      kind: 'personal',
      createdByUserId: userId,
      workspace: { name: 'Default', slug: 'default' },
    });

    // A personal organization is not a lesser one: same table, same workspace,
    // same policies. Only `kind` distinguishes it.
    expect(organization.kind).toBe('personal');
    expect(workspace.organizationId).toBe(organization.id);
  });

  it('rolls back both when the workspace slug collides', async () => {
    // A freshly inserted organization has no workspaces, so no *existing* row can
    // collide with its first one; the reachable way to fail the second statement
    // is a slug the CHECK refuses. What the test proves is the part that matters:
    // the organization insert is undone, so this is one transaction rather than
    // two statements that can leave an organization nobody can use.
    const userId = await makeUser();

    await expect(
      createOrganization({
        name: 'Acme',
        slug: 'acme',
        kind: 'team',
        createdByUserId: userId,
        workspace: { name: 'Production', slug: 'Production Workspace' },
      })
    ).rejects.toMatchObject({ code: '23514' });

    expect(await countOrganizations()).toBe(0);
    expect(await findOrganizationBySlug('acme')).toBeNull();
  });

  it('rejects a slug that is not url safe', async () => {
    const userId = await makeUser();
    const base = { name: 'Acme', kind: 'team' as const, createdByUserId: userId };
    const workspace = { name: 'Production', slug: 'production' };

    // Refused rather than normalised silently: a slug that arrives wrong is a
    // caller bug, and quietly rewriting it means the caller's own records point
    // at a slug that does not exist.
    for (const slug of ['Acme', 'acme corp', 'acme_corp', '-acme', 'acme-', 'a']) {
      await expect(createOrganization({ ...base, slug, workspace })).rejects.toMatchObject({
        code: '23514',
      });
    }

    expect(await countOrganizations()).toBe(0);
  });
});

describe('workspace slug uniqueness', () => {
  it('allows the same workspace slug in two organizations', async () => {
    const userId = await makeUser();

    const acme = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });
    const globex = await createOrganization({
      name: 'Globex',
      slug: 'globex',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    // The uniqueness is scoped to the organization, not global. A global one would
    // mean whoever created 'production' first locked every other tenant out of the
    // most obvious name there is.
    expect(globex.workspace.id).not.toBe(acme.workspace.id);
    expect((await findWorkspaceBySlug(acme.organization.id, 'production'))?.id).toBe(
      acme.workspace.id
    );
    expect((await findWorkspaceBySlug(globex.organization.id, 'production'))?.id).toBe(
      globex.workspace.id
    );
  });

  it('refuses a duplicate workspace slug in one organization', async () => {
    const userId = await makeUser();
    const { organization } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    await expect(insertWorkspace(organization.id, 'production')).rejects.toMatchObject({
      code: '23505',
    });
    expect(await listWorkspaces(organization.id)).toHaveLength(1);
  });

  it('frees a slug when the workspace is soft deleted', async () => {
    const userId = await makeUser();
    const { organization, workspace } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    await softDeleteWorkspace(workspace.id);

    // This is what makes the index partial rather than total: the tombstone keeps
    // the old rows resolvable while the name becomes available again.
    expect(await findWorkspaceBySlug(organization.id, 'production')).toBeNull();
    expect(await listWorkspaces(organization.id)).toEqual([]);

    const recreated = await insertWorkspace(organization.id, 'production');
    expect((await findWorkspaceBySlug(organization.id, 'production'))?.id).toBe(recreated);
  });
});

describe('deleting an organization', () => {
  it('refuses to delete an organization that still has a workspace', async () => {
    const userId = await makeUser();
    const { organization } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    // RESTRICT rather than CASCADE. A cascade here would let one DELETE remove
    // the experiment and deployment rows naming AWS stacks that are still running
    // and still billing, leaving infrastructure nobody can find again.
    await expect(
      query('DELETE FROM organizations WHERE id = $1', [organization.id])
    ).rejects.toMatchObject({ code: '23503' });

    expect(await countOrganizations()).toBe(1);
  });

  it('keeps the organization when the user who created it is deleted', async () => {
    const userId = await makeUser();
    const { organization } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    await query('DELETE FROM users WHERE id = $1', [userId]);

    // ON DELETE SET NULL: an organization outlives the account that opened it,
    // because the other members are still working in it.
    expect((await findOrganizationBySlug('acme'))?.id).toBe(organization.id);
    const { rows } = await query<{ created_by_user_id: string | null }>(
      'SELECT created_by_user_id FROM organizations WHERE id = $1',
      [organization.id]
    );
    expect(rows[0].created_by_user_id).toBeNull();
  });
});

describe('timestamps', () => {
  it('advances updated_at on update', async () => {
    const userId = await makeUser();
    const { organization, workspace } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    // Compared in the database rather than in JavaScript: timestamptz has
    // microsecond resolution and a Date has milliseconds, so two statements this
    // close together can look simultaneous once rounded.
    const advanced = async (table: 'organizations' | 'workspaces', id: string) => {
      const { rows } = await query<{ advanced: boolean }>(
        `SELECT updated_at > created_at AS advanced FROM ${table} WHERE id = $1`,
        [id]
      );
      return rows[0].advanced;
    };

    expect(await advanced('organizations', organization.id)).toBe(false);

    // Neither statement mentions updated_at; the trigger is the only writer.
    await query('UPDATE organizations SET name = $2 WHERE id = $1', [organization.id, 'Acme Inc']);
    await query('UPDATE workspaces SET name = $2 WHERE id = $1', [workspace.id, 'Prod']);

    expect(await advanced('organizations', organization.id)).toBe(true);
    expect(await advanced('workspaces', workspace.id)).toBe(true);
  });
});

describe('lookups', () => {
  it('does not return a soft-deleted organization by slug', async () => {
    const userId = await makeUser();
    const { organization } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    await query('UPDATE organizations SET deleted_at = now() WHERE id = $1', [organization.id]);

    expect(await findOrganizationBySlug('acme')).toBeNull();
  });

  it('treats a malformed organization id as nothing found rather than an error', async () => {
    // Ids arrive from URLs. A malformed one is a request for something that cannot
    // exist, not a server fault.
    expect(await findWorkspaceBySlug('not-a-uuid', 'production')).toBeNull();
    expect(await listWorkspaces('not-a-uuid')).toEqual([]);
    await expect(softDeleteWorkspace('not-a-uuid')).resolves.toBeUndefined();
  });

  it('lists workspaces oldest first so the original workspace leads', async () => {
    const userId = await makeUser();
    const { organization } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });
    await insertWorkspace(organization.id, 'staging');

    expect((await listWorkspaces(organization.id)).map((w) => w.slug)).toEqual([
      'production',
      'staging',
    ]);
  });
});

describe('schema shape', () => {
  it('introduces no enum type', async () => {
    // A value set that will grow must not be an ENUM: ALTER TYPE ... ADD VALUE has
    // no inverse, so rolling it back means recreating the type and rewriting every
    // dependent column -- destructive DDL inside migrate:down.
    const { rows } = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('organizations', 'workspaces')
         AND data_type = 'USER-DEFINED'`
    );
    expect(rows).toEqual([]);
  });
});

describe('findWorkspaceBySlug performance', () => {
  it('resolves a workspace with a single index probe at 10,000 workspaces', async () => {
    const userId = await makeUser();
    const { organization } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });

    // All in one organization, which is the hard case: the organization column
    // alone cannot narrow anything, so only the composite index saves the scan.
    await query(
      `INSERT INTO workspaces (organization_id, slug, name)
       SELECT $1, 'ws-' || to_char(g, 'FM00000'), 'Workspace ' || g
       FROM generate_series(1, 9999) AS g`,
      [organization.id]
    );
    await query('ANALYZE workspaces');

    const { rows } = await query<{
      'QUERY PLAN': [
        { Plan: { 'Node Type': string; 'Index Name'?: string }; 'Execution Time': number },
      ];
    }>(
      `EXPLAIN (ANALYZE, FORMAT JSON)
       SELECT id FROM workspaces
       WHERE organization_id = $1 AND lower(slug) = lower($2) AND deleted_at IS NULL`,
      [organization.id, 'ws-05000']
    );

    const [{ Plan: plan, 'Execution Time': executionTime }] = rows[0]['QUERY PLAN'];

    expect(plan['Node Type']).toBe('Index Scan');
    expect(plan['Index Name']).toBe('workspaces_slug_idx');
    // The budget is server-side execution, measured by the planner, because a
    // wall-clock assertion would be measuring the loopback round trip instead.
    expect(executionTime).toBeLessThan(1);

    expect((await findWorkspaceBySlug(organization.id, 'ws-05000'))?.slug).toBe('ws-05000');
  });
});

/**
 * The round trip Gate 4 performs. It runs last in this file because it drops and
 * recreates the tables every other case depends on.
 */
describe('migration', () => {
  const migrationsDir = fileURLToPath(new URL('../../../../../db/migrations', import.meta.url));

  // DATABASE_URL comes from the environment the setup file has already populated,
  // so dbmate and the pool are pointed at the same database by construction.
  async function dbmate(command: string) {
    return run('dbmate', ['--migrations-dir', migrationsDir, '--no-dump-schema', command]);
  }

  async function tablesExist() {
    const { rows } = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('organizations', 'workspaces')
       ORDER BY table_name`
    );
    return rows.map((r) => r.table_name);
  }

  it('migration rolls back cleanly', async () => {
    expect(await tablesExist()).toEqual(['organizations', 'workspaces']);

    // `rollback` reverses one migration. That is this one today, because it is the
    // newest; the loop keeps the test aimed at this migration once later ones land
    // on top of it, instead of quietly asserting somebody else's rollback.
    for (let step = 0; step < 20 && (await tablesExist()).length > 0; step += 1) {
      await dbmate('rollback');
    }

    // Empty, so the down really dropped both tables rather than erroring past them.
    // A non-empty list here also means the loop gave up, which is the same failure.
    expect(await tablesExist()).toEqual([]);

    await dbmate('up');

    expect(await tablesExist()).toEqual(['organizations', 'workspaces']);

    // Reapplied, not merely present: the indexes, the CHECKs and the trigger all
    // have to come back, or the next rollback is the one that fails.
    const userId = await makeUser();
    const { organization } = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdByUserId: userId,
      workspace: { name: 'Production', slug: 'production' },
    });
    await expect(insertWorkspace(organization.id, 'production')).rejects.toMatchObject({
      code: '23505',
    });
  });
});
