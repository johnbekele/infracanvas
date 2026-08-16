import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import { connectRepository } from './repositories.js';
import {
  createExperiment,
  findExperiment,
  listDeployments,
  listExperiments,
  listExpiredExperiments,
  recordDeployment,
  recordVerdict,
  renameExperiment,
  setExperimentArchived,
  setExperimentStatus,
  type CreateExperimentInput,
} from './experiments.js';
import { putArtifact } from './artifacts.js';

async function makeUser(githubId = 1, username = 'octocat') {
  return findOrCreateUser({
    githubId,
    githubUsername: username,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });
}

async function makeRepository(userId: string) {
  return connectRepository({
    userId,
    githubId: 987_654,
    githubOwner: 'octocat',
    githubName: 'hello-world',
    defaultBranch: 'main',
    isPrivate: false,
  });
}

const HOUR = 60 * 60 * 1000;

function experimentInput(
  userId: string,
  over: Partial<CreateExperimentInput> = {}
): CreateExperimentInput {
  return {
    userId,
    name: 'Aurora Serverless',
    hypothesis: 'Aurora Serverless v2 is cheaper than RDS under bursty load',
    expiresAt: new Date(Date.now() + 8 * HOUR),
    budgetUsd: 25,
    ...over,
  };
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('createExperiment', () => {
  it('records an experiment against the user who created it', async () => {
    const user = await makeUser();

    const experiment = await createExperiment(experimentInput(user.id));

    expect(experiment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(experiment.userId).toBe(user.id);
    expect(experiment.name).toBe('Aurora Serverless');
    expect(experiment.status).toBe('draft');
    expect(experiment.budgetUsd).toBe(25);
    expect(experiment.hypothesis).toBe(
      'Aurora Serverless v2 is cheaper than RDS under bursty load'
    );
    expect(experiment.verdict).toBe('undecided');
    expect(experiment.verdictNote).toBeNull();
    expect(experiment.verdictAt).toBeNull();
    expect(experiment.archivedAt).toBeNull();
    expect(experiment.headRevisionId).toBeNull();
  });

  it('returns the budget as a number rather than the string pg gives for numeric', async () => {
    const user = await makeUser();

    const experiment = await createExperiment(experimentInput(user.id, { budgetUsd: 12.5 }));

    expect(experiment.budgetUsd).toBe(12.5);
    expect(typeof experiment.budgetUsd).toBe('number');
  });

  it('rejects a non positive budget', async () => {
    // A zero budget is not "no limit", it is a limit nothing can satisfy.
    const user = await makeUser();

    await expect(createExperiment(experimentInput(user.id, { budgetUsd: 0 }))).rejects.toThrow();
    await expect(createExperiment(experimentInput(user.id, { budgetUsd: -5 }))).rejects.toThrow();

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM experiments');
    expect(rows[0].count).toBe('0');
  });

  it('rejects an experiment with no expiry', async () => {
    // The TTL is the guardrail that stops this platform producing a surprise AWS
    // bill, so it is not something a caller can decline to set.
    const user = await makeUser();

    await expect(
      createExperiment(experimentInput(user.id, { expiresAt: undefined as unknown as Date }))
    ).rejects.toThrow();
  });

  it('refuses a hypothesis longer than the column allows', async () => {
    const user = await makeUser();

    await expect(
      createExperiment(experimentInput(user.id, { hypothesis: 'x'.repeat(501) }))
    ).rejects.toThrow();
  });
});

describe('setExperimentStatus', () => {
  it('moves the experiment to the new status', async () => {
    const user = await makeUser();
    const experiment = await createExperiment(experimentInput(user.id));

    const deploying = await setExperimentStatus(experiment.id, 'deploying');

    expect(deploying.status).toBe('deploying');
  });

  it('reports a malformed id as not found rather than failing the query', async () => {
    await expect(setExperimentStatus('not-a-uuid', 'ready')).rejects.toThrow(
      'Experiment not found'
    );
  });
});

describe('listExpiredExperiments', () => {
  it('lists experiments past their expiry', async () => {
    const user = await makeUser();
    const expired = await createExperiment(
      experimentInput(user.id, { name: 'Expired', expiresAt: new Date(Date.now() - HOUR) })
    );
    await setExperimentStatus(expired.id, 'deployed');

    const live = await createExperiment(
      experimentInput(user.id, { name: 'Live', expiresAt: new Date(Date.now() + HOUR) })
    );
    await setExperimentStatus(live.id, 'deployed');

    const due = await listExpiredExperiments(new Date());

    expect(due.map((e) => e.name)).toEqual(['Expired']);
  });

  it('excludes drafts from the expiry sweep', async () => {
    // A draft has never provisioned anything, so there is nothing to reclaim.
    const user = await makeUser();
    await createExperiment(
      experimentInput(user.id, { name: 'Draft', expiresAt: new Date(Date.now() - HOUR) })
    );

    expect(await listExpiredExperiments(new Date())).toEqual([]);
  });

  it('excludes already destroyed experiments from the expiry sweep', async () => {
    const user = await makeUser();
    const gone = await createExperiment(
      experimentInput(user.id, { name: 'Destroyed', expiresAt: new Date(Date.now() - HOUR) })
    );
    await setExperimentStatus(gone.id, 'destroyed');

    const failed = await createExperiment(
      experimentInput(user.id, { name: 'Failed', expiresAt: new Date(Date.now() - HOUR) })
    );
    await setExperimentStatus(failed.id, 'failed');

    expect(await listExpiredExperiments(new Date())).toEqual([]);
  });
});

describe('recordDeployment', () => {
  it('records what is needed to destroy the stack again', async () => {
    const user = await makeUser();
    const experiment = await createExperiment(experimentInput(user.id));

    const deployment = await recordDeployment({
      experimentId: experiment.id,
      awsAccountId: '000000000000',
      awsRegion: 'ap-southeast-2',
      stackName: 'infracanvas-aurora',
      status: 'in_progress',
      estimatedMonthlyUsd: 41.5,
    });

    expect(deployment.stackName).toBe('infracanvas-aurora');
    expect(deployment.estimatedMonthlyUsd).toBe(41.5);
    expect(deployment.outputs).toEqual({});
    expect(await listDeployments(experiment.id)).toHaveLength(1);
  });

  it('rejects a deployment missing the fields needed to destroy it', async () => {
    // Without an account, a region and a stack name there is no way to reclaim
    // what the row describes, which is how a test stack becomes a standing bill.
    const user = await makeUser();
    const experiment = await createExperiment(experimentInput(user.id));

    const base = {
      experimentId: experiment.id,
      awsAccountId: '000000000000',
      awsRegion: 'ap-southeast-2',
      stackName: 'infracanvas-aurora',
      status: 'in_progress',
    };

    for (const field of ['awsAccountId', 'awsRegion', 'stackName'] as const) {
      await expect(
        recordDeployment({ ...base, [field]: undefined as unknown as string })
      ).rejects.toThrow();
    }

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM deployments');
    expect(rows[0].count).toBe('0');
  });
});

describe('findExperiment', () => {
  it('finds an experiment belonging to the user', async () => {
    const user = await makeUser();
    const created = await createExperiment(experimentInput(user.id));

    expect((await findExperiment(user.id, created.id))?.id).toBe(created.id);
  });

  it('returns null for an experiment belonging to another user', async () => {
    // The owner is part of the lookup rather than a check afterwards, and the
    // answer is "not found" rather than a permission error: telling a caller the
    // id exists turns a uuid guess into an oracle for who is testing what.
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await createExperiment(experimentInput(alice.id));

    expect(await findExperiment(bob.id, hers.id)).toBeNull();
  });

  it('reads a malformed id as not found rather than failing the query', async () => {
    const user = await makeUser();
    expect(await findExperiment(user.id, 'not-a-uuid')).toBeNull();
  });
});

describe('listExperiments', () => {
  it('returns only the caller\u2019s experiments, newest first', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');

    await createExperiment(experimentInput(alice.id, { name: 'First' }));
    await createExperiment(experimentInput(alice.id, { name: 'Second' }));
    await createExperiment(experimentInput(bob.id, { name: 'Bob\u2019s' }));

    expect((await listExperiments(alice.id)).map((e) => e.name)).toEqual(['Second', 'First']);
  });

  it('hides archived experiments unless asked for them', async () => {
    const user = await makeUser();
    const kept = await createExperiment(experimentInput(user.id, { name: 'Kept' }));
    const shelved = await createExperiment(experimentInput(user.id, { name: 'Shelved' }));
    await setExperimentArchived(user.id, shelved.id, true);

    expect((await listExperiments(user.id)).map((e) => e.name)).toEqual(['Kept']);
    expect((await listExperiments(user.id, { includeArchived: true })).map((e) => e.name)).toEqual([
      'Shelved',
      'Kept',
    ]);
    expect((await findExperiment(user.id, kept.id))?.archivedAt).toBeNull();
  });

  it('filters to one repository', async () => {
    const user = await makeUser();
    const repository = await makeRepository(user.id);
    await createExperiment(
      experimentInput(user.id, { name: 'On repo', repositoryId: repository.id })
    );
    await createExperiment(experimentInput(user.id, { name: 'Detached' }));

    const scoped = await listExperiments(user.id, { repositoryId: repository.id });

    expect(scoped.map((e) => e.name)).toEqual(['On repo']);
  });
});

describe('renameExperiment', () => {
  it('renames and restates the hypothesis without touching anything else', async () => {
    const user = await makeUser();
    const created = await createExperiment(experimentInput(user.id));

    const renamed = await renameExperiment(user.id, created.id, {
      name: 'Aurora vs RDS',
      hypothesis: 'Aurora is cheaper below 40% duty cycle',
    });

    expect(renamed?.name).toBe('Aurora vs RDS');
    expect(renamed?.hypothesis).toBe('Aurora is cheaper below 40% duty cycle');
    expect(renamed?.headRevisionId).toBe(created.headRevisionId);
    expect(renamed?.status).toBe(created.status);
  });

  it('leaves a field alone when it is not supplied', async () => {
    const user = await makeUser();
    const created = await createExperiment(experimentInput(user.id));

    const renamed = await renameExperiment(user.id, created.id, { name: 'Just the name' });

    expect(renamed?.name).toBe('Just the name');
    expect(renamed?.hypothesis).toBe(created.hypothesis);
  });

  it('refuses to rename another user\u2019s experiment', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await createExperiment(experimentInput(alice.id));

    expect(await renameExperiment(bob.id, hers.id, { name: 'Mine now' })).toBeNull();
    expect((await findExperiment(alice.id, hers.id))?.name).toBe('Aurora Serverless');
  });
});

describe('recordVerdict', () => {
  it('stores the verdict with its reason and the moment it was reached', async () => {
    const user = await makeUser();
    const created = await createExperiment(experimentInput(user.id));

    const decided = await recordVerdict(user.id, created.id, 'adopt', 'A third cheaper at p95');

    expect(decided?.verdict).toBe('adopt');
    expect(decided?.verdictNote).toBe('A third cheaper at p95');
    expect(decided?.verdictAt).toBeInstanceOf(Date);
  });

  it('refuses a verdict with no note', async () => {
    // A verdict with no reason and no date is a badge rather than a result: six
    // months later nobody can tell whether "reject" meant too expensive or slow.
    const user = await makeUser();
    const created = await createExperiment(experimentInput(user.id));

    await expect(
      query(`UPDATE experiments SET verdict = 'reject' WHERE id = $1`, [created.id])
    ).rejects.toThrow();

    expect((await findExperiment(user.id, created.id))?.verdict).toBe('undecided');
  });

  it('clears the note and the date when returning to undecided', async () => {
    const user = await makeUser();
    const created = await createExperiment(experimentInput(user.id));
    await recordVerdict(user.id, created.id, 'reject', 'Twice the cost for the same p95');

    const reopened = await recordVerdict(user.id, created.id, 'undecided', '');

    expect(reopened?.verdict).toBe('undecided');
    expect(reopened?.verdictNote).toBeNull();
    expect(reopened?.verdictAt).toBeNull();
  });

  it('refuses to record a verdict on another user\u2019s experiment', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await createExperiment(experimentInput(alice.id));

    expect(await recordVerdict(bob.id, hers.id, 'adopt', 'Not mine to judge')).toBeNull();
  });
});

describe('referential behaviour', () => {
  it('keeps the experiment when its source repository is deleted', async () => {
    // Disconnecting a repository must not destroy the record of what was
    // deployed from it, because that record is how a live stack is found again.
    const user = await makeUser();
    const repository = await makeRepository(user.id);
    const experiment = await createExperiment(
      experimentInput(user.id, { repositoryId: repository.id })
    );

    await query('DELETE FROM repositories WHERE id = $1', [repository.id]);

    const { rows } = await query<{ id: string; repository_id: string | null }>(
      'SELECT id, repository_id FROM experiments WHERE id = $1',
      [experiment.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].repository_id).toBeNull();
  });

  it('cascades deletion from user to experiment to deployment and artifact', async () => {
    const user = await makeUser();
    const experiment = await createExperiment(experimentInput(user.id));
    await recordDeployment({
      experimentId: experiment.id,
      awsAccountId: '000000000000',
      awsRegion: 'ap-southeast-2',
      stackName: 'infracanvas-aurora',
      status: 'in_progress',
    });
    await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'index.ts',
      content: 'export const stack = 1;',
    });

    await query('DELETE FROM users WHERE id = $1', [user.id]);

    for (const table of ['experiments', 'deployments', 'artifacts']) {
      const { rows } = await query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(rows[0].count, `${table} should be empty`).toBe('0');
    }
  });
});

describe('performance', () => {
  it('sweeps expiries from the partial index rather than the table', async () => {
    const user = await makeUser();

    // 100k rows, as the issue's budget specifies. Mostly drafts, which the
    // partial index excludes, so the sweep's index stays small and selective --
    // which is the shape production has.
    await query(
      `INSERT INTO experiments (user_id, name, status, hypothesis, expires_at, budget_usd)
       SELECT $1, 'draft-' || g, 'draft', 'a hypothesis', now() - interval '1 hour', 10
         FROM generate_series(1, 99950) AS g`,
      [user.id]
    );
    await query(
      `INSERT INTO experiments (user_id, name, status, hypothesis, expires_at, budget_usd)
       SELECT $1, 'due-' || g, 'deployed', 'a hypothesis', now() - interval '1 hour', 10
         FROM generate_series(1, 50) AS g`,
      [user.id]
    );
    await query('ANALYZE experiments');

    const { rows } = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT * FROM experiments
        WHERE expires_at < now()
          AND status NOT IN ('destroyed', 'failed', 'draft')`
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(plan).toContain('experiments_expiry_idx');
    expect(plan).not.toContain('Seq Scan');

    const samples: number[] = [];
    for (let run = 0; run < 11; run += 1) {
      const started = performance.now();
      await listExpiredExperiments(new Date());
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    // Measured at a 0.55ms median over these 100k rows against a local Postgres
    // (min 0.47ms, max 1.78ms), because the partial index holds only the 50 rows
    // the sweep can return and so the cost does not follow the table. The issue
    // budgets 20ms, which is some 36x the measurement -- deliberate headroom,
    // since CI runs every package's suite concurrently on a small runner (#152)
    // where the same query spends much of its interval descheduled. The budget
    // is here to catch the sweep falling back to a sequential scan, which the
    // plan assertion above catches directly, rather than to police a few per cent.
    expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(20);
  });
});
