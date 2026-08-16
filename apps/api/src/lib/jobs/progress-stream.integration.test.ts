/**
 * The progress stream, over a real HTTP connection.
 *
 * Supertest buffers a response until it ends, which is precisely the property a
 * stream does not have, so these tests hold an open socket and read frames as
 * they arrive. Anything less would only prove the handler returns -- and a
 * progress stream that delivers everything at the end is the bug, not the test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PROFILE_SCHEMA_VERSION } from '@infracanvas/core';
import { closePool, query } from '../db/client.js';
import { findOrCreateUser } from '../db/users.js';
import { connectRepository } from '../db/repositories.js';
import { completeAnalysis, failAnalysis, queueAnalysis } from '../db/analyses.js';
import { createSessionToken } from '../jwt.js';
import { appendEvent, enqueue } from './queue.js';
import { streamAnalysisProgress } from './progress-stream.js';

const servers: Server[] = [];
const readers: AbortController[] = [];

/**
 * The real router, and a bare mount alongside it.
 *
 * The router is what proves the ownership check; the bare mount is what makes a
 * fifteen-second keepalive testable, by letting the interval be set to something
 * a test can wait for.
 */
async function serve(): Promise<string> {
  const { default: repositoryRoutes } = await import('../../routes/repositories/index.js');
  const app = express();

  app.get('/fast/:analysisId/events', async (req, res) => {
    await streamAnalysisProgress(req, res, req.params.analysisId, {
      pollIntervalMs: 40,
      heartbeatMs: 60,
      maxStreamMs: 5_000,
    });
  });

  app.use('/repositories', repositoryRoutes);

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Stream {
  /** Wait for the accumulated body to satisfy a predicate, then return it. */
  until(predicate: (body: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
}

async function open(url: string, headers: Record<string, string> = {}): Promise<Stream> {
  const controller = new AbortController();
  readers.push(controller);

  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });

  expect(response.headers.get('content-type')).toContain('text/event-stream');

  let body = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        body += decoder.decode(value, { stream: true });
      }
    } catch {
      // Aborted by the test, which is how a stream that never ends is closed.
    }
  })();

  return {
    async until(predicate, timeoutMs = 6_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(body)) return body;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for the stream. Received:\n${body}`);
    },
    close: () => controller.abort(),
  };
}

async function setUp(githubId: number) {
  const user = await findOrCreateUser({
    githubId,
    githubUsername: `user-${githubId}`,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });

  const repository = await connectRepository({
    userId: user.id,
    githubId: githubId * 10,
    githubOwner: `user-${githubId}`,
    githubName: 'hello-world',
    defaultBranch: 'main',
    isPrivate: false,
  });

  const analysis = await queueAnalysis(repository.id, 'main');
  const job = await enqueue({ kind: 'analysis.repository', analysisId: analysis.id });
  const token = await createSessionToken({
    userId: user.id,
    githubId,
    githubUsername: `user-${githubId}`,
  });

  return { user, repository, analysis, job, token };
}

beforeEach(async () => {
  await query('TRUNCATE users, jobs CASCADE');
});

afterEach(async () => {
  for (const controller of readers.splice(0)) controller.abort();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

afterAll(async () => {
  await closePool();
});

describe('the progress stream', () => {
  it('sends the lines a job has already written, with resumable ids', async () => {
    const base = await serve();
    const { analysis, job } = await setUp(1);
    await appendEvent(job.id, { level: 'info', message: 'Listed 812 files.', progress: 0.1 });
    await appendEvent(job.id, { level: 'info', message: 'Read 40 of 40 files.', progress: 0.85 });

    const stream = await open(`${base}/fast/${analysis.id}/events`);
    const body = await stream.until((text) => text.includes('Read 40 of 40 files.'));

    expect(body).toContain('event: progress');
    expect(body).toMatch(/id: \d+/);
    // A client joining late still learns everything that happened, which is what
    // makes a reload mid-analysis show progress rather than an empty bar.
    expect(body).toContain('Listed 812 files.');
  });

  it('resumes an event stream from Last-Event-ID', async () => {
    const base = await serve();
    const { analysis, job } = await setUp(2);
    await appendEvent(job.id, { level: 'info', message: 'first', progress: 0.1 });
    await appendEvent(job.id, { level: 'info', message: 'second', progress: 0.2 });

    const first = await open(`${base}/fast/${analysis.id}/events`);
    const seen = await first.until((text) => text.includes('second'));
    const lastId = [...seen.matchAll(/id: (\d+)/g)].at(-1)![1];
    first.close();

    await appendEvent(job.id, { level: 'info', message: 'third', progress: 0.3 });

    const resumed = await open(`${base}/fast/${analysis.id}/events`, { 'Last-Event-ID': lastId });
    const body = await resumed.until((text) => text.includes('third'));

    // The point of the cursor: a dropped connection costs a reconnect, not a
    // replay of everything the run has logged.
    expect(body).not.toContain('first');
    expect(body).not.toContain('second');
  });

  it('emits a keepalive on an idle stream', async () => {
    const base = await serve();
    const { analysis } = await setUp(3);

    const stream = await open(`${base}/fast/${analysis.id}/events`);

    // A comment frame, which a proxy counts as traffic and a client ignores.
    // Without it an idle analysis is closed as a dead connection.
    await stream.until((text) => text.includes(': keep-alive'));
  });

  it('ends the stream when the run succeeds', async () => {
    const base = await serve();
    const { analysis, job } = await setUp(4);

    const stream = await open(`${base}/fast/${analysis.id}/events`);
    await stream.until((text) => text.includes(': keep-alive') || text.length > 0, 2_000);

    await completeAnalysis(analysis.id, {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      commitSha: 'b'.repeat(40),
      ref: 'main',
      analysedAt: new Date().toISOString(),
      languages: [],
      components: [],
      dependencies: [],
      composeServices: [],
      containerisation: { dockerfiles: [], composeFiles: [], exposedPorts: [] },
      fileCount: 0,
      totalBytes: 0,
      notes: [],
    });
    await appendEvent(job.id, { level: 'info', message: 'Finished.', progress: 1 });

    const body = await stream.until((text) => text.includes('event: succeeded'));

    // The closing line is drained before the outcome frame, so the client is
    // never told the run ended before being told how.
    expect(body.indexOf('Finished.')).toBeLessThan(body.indexOf('event: succeeded'));
  });

  it('reports a failed run with the reason', async () => {
    const base = await serve();
    const { analysis } = await setUp(5);
    await failAnalysis(analysis.id, 'GitHub returned 404 while fetching the file tree');

    const stream = await open(`${base}/fast/${analysis.id}/events`);
    const body = await stream.until((text) => text.includes('event: failed'));

    expect(body).toContain('GitHub returned 404 while fetching the file tree');
  });
});

describe('the stream route', () => {
  it("refuses to stream another user's analysis", async () => {
    const base = await serve();
    const mine = await setUp(6);
    const theirs = await setUp(7);

    const response = await fetch(
      `${base}/repositories/${theirs.repository.id}/analyses/${theirs.analysis.id}/events`,
      { headers: { Authorization: `Bearer ${mine.token}` } }
    );

    // 404 rather than 403: confirming that someone else's analysis exists is
    // itself something this caller should not learn.
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });

  it('refuses a caller with no session', async () => {
    const base = await serve();
    const { repository, analysis } = await setUp(8);

    const response = await fetch(
      `${base}/repositories/${repository.id}/analyses/${analysis.id}/events`
    );

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it('streams a run to the user who owns it', async () => {
    const base = await serve();
    const { repository, analysis, job, token } = await setUp(9);
    await appendEvent(job.id, { level: 'info', message: 'Resolved main.', progress: 0.05 });

    const stream = await open(
      `${base}/repositories/${repository.id}/analyses/${analysis.id}/events`,
      { Authorization: `Bearer ${token}` }
    );

    await stream.until((text) => text.includes('Resolved main.'));
  });
});
