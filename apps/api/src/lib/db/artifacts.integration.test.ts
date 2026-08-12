import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import { createExperiment } from './experiments.js';
import { listArtifacts, putArtifact } from './artifacts.js';

async function makeExperiment() {
  const user = await findOrCreateUser({
    githubId: 1,
    githubUsername: 'octocat',
    githubAvatar: 'https://avatars.githubusercontent.com/u/1',
  });

  return createExperiment({
    userId: user.id,
    name: 'Aurora Serverless',
    hypothesis: 'The generated program is the one that gets deployed',
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    budgetUsd: 25,
  });
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('putArtifact', () => {
  it('stores the artifact with a digest of its content', async () => {
    const experiment = await makeExperiment();
    const content = 'export const bucket = new aws.s3.Bucket("assets");';

    const artifact = await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'index.ts',
      content,
    });

    expect(artifact.kind).toBe('pulumi_program');
    expect(artifact.path).toBe('index.ts');
    expect(artifact.content).toBe(content);
    expect(artifact.contentSha256).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
  });

  it('replaces an artifact of the same kind and path', async () => {
    // Regenerating a program is ordinary, and two rows differing only in
    // created_at would leave the question of which one would be deployed.
    const experiment = await makeExperiment();

    const first = await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'index.ts',
      content: 'export const version = 1;',
    });
    const second = await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'index.ts',
      content: 'export const version = 2;',
    });

    expect(second.id).toBe(first.id);
    expect(second.content).toBe('export const version = 2;');
    expect(second.contentSha256).not.toBe(first.contentSha256);

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM artifacts');
    expect(rows[0].count).toBe('1');
  });

  it('keeps artifacts of the same kind at different paths apart', async () => {
    const experiment = await makeExperiment();

    await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'index.ts',
      content: 'a',
    });
    await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'network.ts',
      content: 'b',
    });

    expect(await listArtifacts(experiment.id)).toHaveLength(2);
  });
});

describe('listArtifacts', () => {
  it('returns every artifact for the experiment when no kind is given', async () => {
    const experiment = await makeExperiment();
    await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'index.ts',
      content: 'a',
    });
    await putArtifact({
      experimentId: experiment.id,
      kind: 'cost_report',
      path: 'cost.json',
      content: '{}',
    });

    const artifacts = await listArtifacts(experiment.id);

    expect(artifacts.map((a) => a.kind)).toEqual(['pulumi_program', 'cost_report']);
  });

  it('filters to one kind when asked', async () => {
    const experiment = await makeExperiment();
    await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'index.ts',
      content: 'a',
    });
    await putArtifact({
      experimentId: experiment.id,
      kind: 'cost_report',
      path: 'cost.json',
      content: '{}',
    });

    const reports = await listArtifacts(experiment.id, 'cost_report');

    expect(reports).toHaveLength(1);
    expect(reports[0].path).toBe('cost.json');
  });

  it('reads a malformed experiment id as having no artifacts', async () => {
    expect(await listArtifacts('not-a-uuid')).toEqual([]);
  });

  it('does not return another experiment\u2019s artifacts', async () => {
    const experiment = await makeExperiment();
    const other = await createExperiment({
      userId: experiment.userId,
      name: 'RDS baseline',
      hypothesis: 'The generated program is the one that gets deployed',
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      budgetUsd: 25,
    });

    await putArtifact({
      experimentId: experiment.id,
      kind: 'pulumi_program',
      path: 'index.ts',
      content: 'a',
    });

    expect(await listArtifacts(other.id)).toEqual([]);
  });
});
