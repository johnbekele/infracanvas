/**
 * The Postgres adapter of `TranscriptStore`.
 *
 * The two behaviours worth a live database are the ones the schema enforces
 * rather than this adapter: that a second streaming turn is refused even when
 * both requests arrive at once, and that two concurrent appends cannot take the
 * same sequence number.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IR_PATCH_VERSION, type IrPatch, type PatchPreview } from '@infracanvas/core';
import { IR_VERSION, type ArchitectureIr } from '@infracanvas/ir-schema';

import { closePool, query } from '../db/client.js';
import { createExperiment } from '../db/experiments.js';
import { appendRevision } from '../db/experiment-revisions.js';
import { findOrCreateUser } from '../db/users.js';
import { ExperimentNotFoundError } from './errors.js';
import { PostgresCopilotStore } from './postgres-store.js';
import { PostgresTranscriptStore } from './postgres-transcript.js';
import type { CopilotScope } from './store.js';
import { TurnAlreadyStreamingError } from './transcript.js';

const transcript = new PostgresTranscriptStore();
const copilot = new PostgresCopilotStore();

function document(): ArchitectureIr {
  return JSON.parse(
    readFileSync(
      new URL('../../../../../packages/ir-schema/fixtures/three-tier.json', import.meta.url),
      'utf8'
    )
  ) as ArchitectureIr;
}

async function makeUser(githubId = 1, username = 'octocat') {
  return findOrCreateUser({
    githubId,
    githubUsername: username,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });
}

async function makeExperiment(userId: string): Promise<CopilotScope> {
  const experiment = await createExperiment({
    userId,
    name: 'Aurora Serverless',
    hypothesis: 'Multi-AZ is worth its price under an AZ failure',
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    budgetUsd: 25,
  });

  await appendRevision(userId, {
    experimentId: experiment.id,
    parentId: null,
    ir: document(),
    irVersion: IR_VERSION,
    summary: 'Proposed from the analysis',
    source: 'proposal',
    authorKind: 'system',
  });

  return { experimentId: experiment.id, userId };
}

/** A proposal row, so a message that announced one can point at something real. */
async function makeProposal(scope: CopilotScope): Promise<string> {
  const experiment = await copilot.experiment(scope);
  const patch: IrPatch = {
    patchVersion: IR_PATCH_VERSION,
    basedOnIrDigest: experiment.irDigest,
    summary: 'Make the database survive an AZ failure',
    ops: [{ op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true }],
  };

  const proposal = await copilot.insertProposal(scope, {
    experimentId: scope.experimentId,
    userId: scope.userId,
    patchDigest: 'd'.repeat(64),
    basedOnIrDigest: experiment.irDigest,
    patch,
    inverse: { ...patch, summary: 'Undo' },
    patchedIr: experiment.ir,
    // Only the bytes matter here; nothing in this suite prices or applies it.
    preview: { touchedNodeIds: ['rds-primary'] } as PatchPreview,
    rationale: 'Because the database is the weakest resource on the path.',
  });
  return proposal.id;
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('conversation', () => {
  it('creates one conversation per experiment and then returns it', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    const first = await transcript.conversation(scope);
    const second = await transcript.conversation(scope);

    expect(second.id).toBe(first.id);
    expect(first.experimentId).toBe(scope.experimentId);
    expect(first.userId).toBe(user.id);
  });

  it('answers an unknown experiment and another user\u2019s the same way', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);

    await expect(
      transcript.conversation({ experimentId: hers.experimentId, userId: bob.id })
    ).rejects.toBeInstanceOf(ExperimentNotFoundError);
    await expect(
      transcript.conversation({
        experimentId: '00000000-0000-4000-8000-000000000000',
        userId: alice.id,
      })
    ).rejects.toBeInstanceOf(ExperimentNotFoundError);
  });

  it('opens one conversation when two turns start at once', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    const [first, second] = await Promise.all([
      transcript.conversation(scope),
      transcript.conversation(scope),
    ]);

    expect(second.id).toBe(first.id);
  });
});

describe('append', () => {
  it('numbers messages from one, in the order they were appended', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    await transcript.append(scope, { role: 'user', content: 'A question', status: 'complete' });
    await transcript.append(scope, { role: 'assistant', content: '', status: 'streaming' });

    const messages = await transcript.messages(scope);
    expect(messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1].lastEventSeq).toBe(0);
    expect(messages[1].toolCalls).toEqual([]);
    expect(messages[1].citations).toEqual([]);
    expect(messages[1].proposalId).toBeNull();
  });

  it('refuses a second streaming turn in one conversation', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    await transcript.append(scope, { role: 'assistant', content: '', status: 'streaming' });

    const second = transcript.append(scope, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    await expect(second).rejects.toBeInstanceOf(TurnAlreadyStreamingError);
  });

  it('allows the next turn once the first one finished', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const first = await transcript.append(scope, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });
    await transcript.update(scope, first.id, { status: 'complete' });

    const second = await transcript.append(scope, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    expect(second.seq).toBe(2);
  });

  it('lets exactly one of two simultaneous turns start', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    const results = await Promise.allSettled([
      transcript.append(scope, { role: 'assistant', content: '', status: 'streaming' }),
      transcript.append(scope, { role: 'assistant', content: '', status: 'streaming' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(TurnAlreadyStreamingError);
    expect(await transcript.messages(scope)).toHaveLength(1);
  });

  it('gives two concurrent appends different sequence numbers', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    await Promise.all([
      transcript.append(scope, { role: 'user', content: 'First', status: 'complete' }),
      transcript.append(scope, { role: 'user', content: 'Second', status: 'complete' }),
    ]);

    expect((await transcript.messages(scope)).map((message) => message.seq)).toEqual([1, 2]);
  });

  it('refuses to append to another user\u2019s experiment', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);

    const asBob = transcript.append(
      { experimentId: hers.experimentId, userId: bob.id },
      { role: 'user', content: 'Show me their architecture', status: 'complete' }
    );

    await expect(asBob).rejects.toBeInstanceOf(ExperimentNotFoundError);
  });
});

describe('message', () => {
  it('returns null for a message that is not this user\u2019s', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);
    const his = await makeExperiment(bob.id);
    const message = await transcript.append(hers, {
      role: 'user',
      content: 'A question',
      status: 'complete',
    });

    expect(await transcript.message(his, message.id)).toBeNull();
    expect(
      await transcript.message({ experimentId: hers.experimentId, userId: bob.id }, message.id)
    ).toBeNull();
    expect(await transcript.message(hers, message.id)).toMatchObject({ id: message.id });
  });

  it('returns null for an id that is not a message', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    expect(await transcript.message(scope, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await transcript.message(scope, 'not-a-uuid')).toBeNull();
  });
});

describe('update', () => {
  it('writes only the fields the patch mentions', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const message = await transcript.append(scope, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    await transcript.update(scope, message.id, { content: 'Multi-AZ ', lastEventSeq: 1 });
    await transcript.update(scope, message.id, {
      toolCalls: [
        { callId: 'c1', tool: 'price_change', summary: 'priced a change', ok: true, durationMs: 4 },
      ],
      lastEventSeq: 2,
    });
    const settled = await transcript.update(scope, message.id, {
      content: 'Multi-AZ costs more.',
      status: 'complete',
      lastEventSeq: 3,
      inputTokens: 120,
      outputTokens: 40,
      unverifiedCitations: 1,
    });

    expect(settled.content).toBe('Multi-AZ costs more.');
    expect(settled.status).toBe('complete');
    expect(settled.lastEventSeq).toBe(3);
    expect(settled.inputTokens).toBe(120);
    expect(settled.outputTokens).toBe(40);
    expect(settled.unverifiedCitations).toBe(1);
    // Untouched by the last patch, and still there.
    expect(settled.toolCalls).toHaveLength(1);
    expect(settled.toolCalls[0].tool).toBe('price_change');
  });

  it('records the proposal a turn announced, and clearing it again', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposalId = await makeProposal(scope);
    const message = await transcript.append(scope, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    expect((await transcript.update(scope, message.id, { proposalId })).proposalId).toBe(
      proposalId
    );
    // A null is a real edit rather than "not mentioned", which COALESCE could not
    // have expressed.
    expect(
      (await transcript.update(scope, message.id, { proposalId: null })).proposalId
    ).toBeNull();
  });

  it('keeps the citations a turn verified', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const message = await transcript.append(scope, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    const updated = await transcript.update(scope, message.id, {
      citations: [
        { scheme: 'file', target: 'apps/api/src/index.ts', verified: true, reason: null },
        { scheme: 'sku', target: 'db.t3.micro', verified: false, reason: 'no such SKU' },
      ],
    });

    expect(updated.citations).toHaveLength(2);
    expect(updated.citations[1].verified).toBe(false);
  });

  it('records an error code beside the status that explains it', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const message = await transcript.append(scope, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    const failed = await transcript.update(scope, message.id, {
      status: 'error',
      errorCode: 'internal',
    });

    expect(failed.status).toBe('error');
    expect(failed.errorCode).toBe('internal');
  });

  it('refuses to write a message through another user\u2019s experiment', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);
    const message = await transcript.append(hers, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    const asBob = transcript.update(
      { experimentId: hers.experimentId, userId: bob.id },
      message.id,
      { content: 'Not yours' }
    );

    await expect(asBob).rejects.toThrow(`No message ${message.id}`);
    expect((await transcript.message(hers, message.id))?.content).toBe('');
  });
});
