import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import { connectRepository } from './repositories.js';
import {
  completeIngestionRun,
  failIngestionRun,
  latestSucceededRun,
  startIngestionRun,
} from './ingestion-runs.js';

const COMMIT = 'a'.repeat(40);

async function makeRepository(githubId = 1, githubName = 'hello-world') {
  const user = await findOrCreateUser({
    githubId,
    githubUsername: `user-${githubId}`,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });

  const repository = await connectRepository({
    userId: user.id,
    githubId: 900_000 + githubId,
    githubOwner: 'octocat',
    githubName,
    defaultBranch: 'main',
    isPrivate: false,
  });

  return { user, repository };
}

/** Postgres 23505, raised here by the one-active-run partial unique index. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function countRuns(): Promise<string> {
  const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM ingestion_runs');
  return rows[0].count;
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('startIngestionRun', () => {
  it('records the commit the run is indexing, not just the ref it came from', async () => {
    const { repository } = await makeRepository();

    const run = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: COMMIT,
      ref: 'refs/heads/main',
    });

    expect(run.commitSha).toBe(COMMIT);
    expect(run.ref).toBe('refs/heads/main');
    expect(run.status).toBe('running');
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.finishedAt).toBeNull();
    expect(run.filesTotal).toBe(0);
    expect(run.chunksWritten).toBe(0);
  });

  it('refuses a second concurrent run for one repository', async () => {
    const { repository } = await makeRepository();
    await startIngestionRun({ repositoryId: repository.id, commitSha: COMMIT, ref: 'main' });

    // Two passes writing chunks for the same repository at once would interleave
    // their output, leaving an index that belongs to neither commit.
    await expect(
      startIngestionRun({ repositoryId: repository.id, commitSha: 'b'.repeat(40), ref: 'main' })
    ).rejects.toSatisfy(isUniqueViolation);

    expect(await countRuns()).toBe('1');
  });

  it('refuses a second run while the first is still pending', async () => {
    // The partial index covers 'pending' as well as 'running', so a run queued
    // but not yet picked up still holds the slot.
    const { repository } = await makeRepository();
    const first = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: COMMIT,
      ref: 'main',
    });
    await query(`UPDATE ingestion_runs SET status = 'pending' WHERE id = $1`, [first.id]);

    await expect(
      startIngestionRun({ repositoryId: repository.id, commitSha: COMMIT, ref: 'main' })
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('allows a new run once the previous one finished', async () => {
    const { repository } = await makeRepository();
    const first = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: COMMIT,
      ref: 'main',
    });
    await completeIngestionRun(first.id, { filesTotal: 1, filesParsed: 1, chunksWritten: 1 });

    const second = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: 'c'.repeat(40),
      ref: 'main',
    });

    expect(second.id).not.toBe(first.id);
    expect(await countRuns()).toBe('2');
  });

  it('allows a new run after the previous one failed', async () => {
    // Re-ingestion is the normal response to a failure, so a dead run must not
    // hold the repository's only slot.
    const { repository } = await makeRepository();
    const first = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: COMMIT,
      ref: 'main',
    });
    await failIngestionRun(first.id, 'clone timed out');

    await expect(
      startIngestionRun({ repositoryId: repository.id, commitSha: COMMIT, ref: 'main' })
    ).resolves.toMatchObject({ status: 'running' });
  });

  it('lets two repositories ingest at the same time', async () => {
    const one = await makeRepository(1, 'first-repo');
    const two = await makeRepository(2, 'second-repo');

    await startIngestionRun({ repositoryId: one.repository.id, commitSha: COMMIT, ref: 'main' });
    await startIngestionRun({ repositoryId: two.repository.id, commitSha: COMMIT, ref: 'main' });

    // The constraint is per repository; a global one would serialise every
    // user's ingestion behind whoever started first.
    expect(await countRuns()).toBe('2');
  });
});

describe('completeIngestionRun', () => {
  it('records counts and finished_at on completion', async () => {
    const { repository } = await makeRepository();
    const run = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: COMMIT,
      ref: 'main',
    });

    const completed = await completeIngestionRun(run.id, {
      filesTotal: 912,
      filesParsed: 874,
      chunksWritten: 5_310,
    });

    expect(completed.status).toBe('succeeded');
    expect(completed.filesTotal).toBe(912);
    expect(completed.filesParsed).toBe(874);
    expect(completed.chunksWritten).toBe(5_310);
    expect(completed.finishedAt).toBeInstanceOf(Date);
    expect(completed.error).toBeNull();
  });

  it('throws for a run that does not exist', async () => {
    await expect(
      completeIngestionRun('00000000-0000-0000-0000-000000000000', {
        filesTotal: 0,
        filesParsed: 0,
        chunksWritten: 0,
      })
    ).rejects.toThrow('Ingestion run not found');
  });
});

describe('failIngestionRun', () => {
  it('records the error message on failure', async () => {
    const { repository } = await makeRepository();
    const run = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: COMMIT,
      ref: 'main',
    });

    const failed = await failIngestionRun(run.id, 'tree-sitter panicked on src/lib.rs');

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('tree-sitter panicked on src/lib.rs');
    expect(failed.finishedAt).toBeInstanceOf(Date);
  });

  it('throws for a run that does not exist', async () => {
    await expect(failIngestionRun('00000000-0000-0000-0000-000000000000', 'nope')).rejects.toThrow(
      'Ingestion run not found'
    );
  });
});

describe('latestSucceededRun', () => {
  it('latestSucceededRun ignores runs that failed', async () => {
    const { repository } = await makeRepository();

    const succeeded = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: COMMIT,
      ref: 'main',
    });
    await completeIngestionRun(succeeded.id, {
      filesTotal: 10,
      filesParsed: 10,
      chunksWritten: 40,
    });

    const later = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: 'd'.repeat(40),
      ref: 'main',
    });
    await failIngestionRun(later.id, 'out of memory');

    // Retrieval must fall back to the last complete index rather than read a
    // half-written one just because it is newer.
    const latest = await latestSucceededRun(repository.id);
    expect(latest?.id).toBe(succeeded.id);
    expect(latest?.commitSha).toBe(COMMIT);
  });

  it('ignores a run that is still in flight', async () => {
    const { repository } = await makeRepository();
    await startIngestionRun({ repositoryId: repository.id, commitSha: COMMIT, ref: 'main' });

    expect(await latestSucceededRun(repository.id)).toBeNull();
  });

  it('returns the most recently finished of several successes', async () => {
    const { repository } = await makeRepository();

    const older = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: COMMIT,
      ref: 'main',
    });
    await completeIngestionRun(older.id, { filesTotal: 1, filesParsed: 1, chunksWritten: 1 });

    const newer = await startIngestionRun({
      repositoryId: repository.id,
      commitSha: 'e'.repeat(40),
      ref: 'main',
    });
    await completeIngestionRun(newer.id, { filesTotal: 2, filesParsed: 2, chunksWritten: 2 });

    expect((await latestSucceededRun(repository.id))?.id).toBe(newer.id);
  });

  it('returns null for a repository that has never been ingested', async () => {
    const { repository } = await makeRepository();
    expect(await latestSucceededRun(repository.id)).toBeNull();
  });
});

describe('cascading deletes', () => {
  it('cascades deletion from user to repository to run', async () => {
    const { user, repository } = await makeRepository();
    await startIngestionRun({ repositoryId: repository.id, commitSha: COMMIT, ref: 'main' });

    await query('DELETE FROM users WHERE id = $1', [user.id]);

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM repositories');
    expect(rows[0].count).toBe('0');
    expect(await countRuns()).toBe('0');
  });

  it('removes a repository’s runs when the repository alone is disconnected', async () => {
    const { repository } = await makeRepository();
    await startIngestionRun({ repositoryId: repository.id, commitSha: COMMIT, ref: 'main' });

    await query('DELETE FROM repositories WHERE id = $1', [repository.id]);

    expect(await countRuns()).toBe('0');
  });
});
