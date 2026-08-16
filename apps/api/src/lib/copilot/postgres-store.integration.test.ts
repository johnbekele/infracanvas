/**
 * The Postgres adapter of `CopilotStore`, against the schema it is written for.
 *
 * The properties under test are the ones a unit test with a fake cannot show:
 * that the scope is in the SQL rather than in a wrapper, that the open-proposal
 * index makes "the same edit twice is one proposal" true of the table, and that
 * `apply` serialises two writers instead of trusting them to arrive in order.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  irDigest,
  IR_PATCH_VERSION,
  proposeArchitecture,
  PROFILE_SCHEMA_VERSION,
  type AppProfile,
  type IrPatch,
  type IrPatchOp,
} from '@infracanvas/core';
import { IR_VERSION, type ArchitectureIr } from '@infracanvas/ir-schema';
import { readFileSync } from 'node:fs';

import { beginAnalysis, completeAnalysis, queueAnalysis } from '../db/analyses.js';
import { closePool, query } from '../db/client.js';
import { createExperiment } from '../db/experiments.js';
import { appendRevision, listRevisions } from '../db/experiment-revisions.js';
import { connectRepository } from '../db/repositories.js';
import { findOrCreateUser } from '../db/users.js';
import { ExperimentNotFoundError } from './errors.js';
import { PostgresCopilotStore } from './postgres-store.js';
import { localPreviewPlane } from './preview-plane.js';
import type { CopilotScope, ProposalRecord } from './store.js';

const MULTI_AZ: IrPatchOp = {
  op: 'set_param',
  nodeId: 'rds-primary',
  param: 'multiAz',
  value: true,
};
const SCALE_OUT: IrPatchOp = {
  op: 'set_param',
  nodeId: 'ecs-api',
  param: 'desiredCount',
  value: 4,
};

const store = new PostgresCopilotStore();
const preview = localPreviewPlane();

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

async function makeRepository(userId: string, githubId = 987_654) {
  return connectRepository({
    userId,
    githubId,
    githubOwner: 'octocat',
    githubName: `hello-world-${githubId}`,
    defaultBranch: 'main',
    isPrivate: false,
  });
}

/** An experiment with its first revision, which is the state every route sees. */
async function makeExperiment(
  userId: string,
  over: { name?: string; repositoryId?: string } = {}
): Promise<CopilotScope> {
  const experiment = await createExperiment({
    userId,
    name: over.name ?? 'Aurora Serverless',
    repositoryId: over.repositoryId ?? null,
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

/**
 * A proposal recorded exactly as `propose_patch` records one: the patch is priced
 * by the real preview plane, so `patchedIr`, `inverse` and the digests are the
 * bytes the user would have been shown rather than plausible stand-ins.
 */
async function propose(
  scope: CopilotScope,
  ops: IrPatchOp[] = [MULTI_AZ]
): Promise<ProposalRecord> {
  const current = await store.experiment(scope);
  const patch: IrPatch = {
    patchVersion: IR_PATCH_VERSION,
    basedOnIrDigest: current.irDigest,
    summary: 'Make the database survive an AZ failure',
    ops,
  };

  const result = await preview.preview(current.ir, patch);
  if (result.patchedIr === null || result.inverse === null) {
    throw new Error('the fixture patch should apply');
  }

  return store.insertProposal(scope, {
    experimentId: scope.experimentId,
    userId: scope.userId,
    patchDigest: result.preview.patchDigest,
    basedOnIrDigest: result.preview.basedOnIrDigest,
    patch,
    inverse: result.inverse,
    patchedIr: result.patchedIr,
    preview: result.preview,
    rationale: 'The database is the weakest resource on the path.',
  });
}

function appProfile(): AppProfile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    commitSha: 'c'.repeat(40),
    ref: 'main',
    analysedAt: '2026-08-12T00:00:00.000Z',
    languages: [{ name: 'TypeScript', bytes: 2000, share: 1 }],
    components: [],
    dependencies: [],
    composeServices: [],
    containerisation: { dockerfiles: [], composeFiles: [], exposedPorts: [] },
    notes: [],
    fileCount: 12,
    totalBytes: 2000,
  };
}

async function countProposals(): Promise<number> {
  const result = await query<{ count: string }>('SELECT count(*) AS count FROM copilot_proposals');
  return Number(result.rows[0].count);
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('experiment', () => {
  it('reads the document from the head revision rather than the experiment row', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id, { name: 'shop' });

    const experiment = await store.experiment(scope);

    expect(experiment.name).toBe('shop');
    expect(experiment.ir).toEqual(document());
    expect(experiment.irDigest).toBe(irDigest(document()));
  });

  it('answers an unknown experiment and another user\u2019s the same way', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);

    const unknown = store.experiment({
      experimentId: '00000000-0000-4000-8000-000000000000',
      userId: alice.id,
    });
    const stranger = store.experiment({ experimentId: hers.experimentId, userId: bob.id });

    await expect(unknown).rejects.toBeInstanceOf(ExperimentNotFoundError);
    await expect(stranger).rejects.toBeInstanceOf(ExperimentNotFoundError);
    // Same message too: a different one would confirm which of the two it was.
    await expect(stranger).rejects.toThrow(`No experiment ${hers.experimentId}`);
  });

  it('reports an experiment that holds no architecture as missing', async () => {
    const user = await makeUser();
    const experiment = await createExperiment({
      userId: user.id,
      name: 'Nothing drawn yet',
      hypothesis: 'A hypothesis with no architecture behind it',
      expiresAt: new Date(Date.now() + 60_000),
      budgetUsd: 5,
    });

    const read = store.experiment({ experimentId: experiment.id, userId: user.id });

    await expect(read).rejects.toBeInstanceOf(ExperimentNotFoundError);
  });

  it('does not treat a malformed id as a query error', async () => {
    const user = await makeUser();

    await expect(
      store.experiment({ experimentId: 'not-a-uuid', userId: user.id })
    ).rejects.toBeInstanceOf(ExperimentNotFoundError);
  });
});

describe('profile', () => {
  it('returns the profile of the repository\u2019s latest succeeded analysis', async () => {
    const user = await makeUser();
    const repository = await makeRepository(user.id);
    const scope = await makeExperiment(user.id, { repositoryId: repository.id });

    const queued = await queueAnalysis(repository.id, 'main');
    await beginAnalysis(queued.id);
    const profile = appProfile();
    await completeAnalysis(queued.id, profile, proposeArchitecture(profile, 'shop'));

    expect((await store.profile(scope))?.commitSha).toBe(profile.commitSha);
  });

  it('returns null when the repository has no succeeded analysis', async () => {
    const user = await makeUser();
    const repository = await makeRepository(user.id);
    const scope = await makeExperiment(user.id, { repositoryId: repository.id });
    await queueAnalysis(repository.id, 'main');

    expect(await store.profile(scope)).toBeNull();
  });

  it('returns null for an experiment with no repository behind it', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    expect(await store.profile(scope)).toBeNull();
  });

  it('is scoped: another user gets the same refusal as for an unknown experiment', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const repository = await makeRepository(alice.id);
    const hers = await makeExperiment(alice.id, { repositoryId: repository.id });

    await expect(
      store.profile({ experimentId: hers.experimentId, userId: bob.id })
    ).rejects.toBeInstanceOf(ExperimentNotFoundError);
  });
});

describe('insertProposal and openProposal', () => {
  it('makes the same edit proposed twice one proposal', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    const first = await propose(scope);
    const second = await propose(scope);

    expect(second.id).toBe(first.id);
    expect(await countProposals()).toBe(1);
  });

  it('finds the open proposal by its digest and stops finding it once decided', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);

    expect(await store.openProposal(scope, proposal.patchDigest)).toMatchObject({
      id: proposal.id,
    });

    await store.decide(scope, proposal.id, 'accepted');

    // An accepted proposal is no longer the open one: proposing the same edit
    // again should produce a new card rather than reopening a decided one.
    expect(await store.openProposal(scope, proposal.patchDigest)).toBeNull();
  });

  it('lets the same edit be proposed again once the first was decided', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const first = await propose(scope);
    await store.decide(scope, first.id, 'rejected');

    const second = await propose(scope);

    expect(second.id).not.toBe(first.id);
    expect(second.patchDigest).toBe(first.patchDigest);
    expect(await countProposals()).toBe(2);
  });

  it('refuses to record a proposal against another user\u2019s experiment', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);

    const asBob = propose({ experimentId: hers.experimentId, userId: bob.id });

    await expect(asBob).rejects.toBeInstanceOf(ExperimentNotFoundError);
    expect(await countProposals()).toBe(0);
  });

  it('refuses to look for an open proposal in an experiment that is not the caller\u2019s', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);
    const proposal = await propose(hers);

    const asBob = store.openProposal(
      { experimentId: hers.experimentId, userId: bob.id },
      proposal.patchDigest
    );

    await expect(asBob).rejects.toBeInstanceOf(ExperimentNotFoundError);
  });
});

describe('proposal', () => {
  it('does not return one user\u2019s proposal through another user\u2019s experiment', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);
    const his = await makeExperiment(bob.id);
    const proposal = await propose(hers);

    expect(await store.proposal(his, proposal.id)).toBeNull();
    await expect(
      store.proposal({ experimentId: hers.experimentId, userId: bob.id }, proposal.id)
    ).rejects.toBeInstanceOf(ExperimentNotFoundError);
  });

  it('returns null for an id that is not a proposal of this experiment', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    expect(await store.proposal(scope, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await store.proposal(scope, 'not-a-uuid')).toBeNull();
  });
});

describe('decide', () => {
  it('records the decision and when it was taken', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);

    const decided = await store.decide(scope, proposal.id, 'accepted');

    expect(decided?.status).toBe('accepted');
    expect(decided?.decidedAt).not.toBeNull();
  });

  it('refuses to re-decide a proposal that was already decided', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);
    await store.decide(scope, proposal.id, 'accepted');

    const again = await store.decide(scope, proposal.id, 'rejected');

    expect(again?.status).toBe('accepted');
  });

  it('returns null for a proposal that does not exist', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    expect(
      await store.decide(scope, '00000000-0000-4000-8000-000000000000', 'accepted')
    ).toBeNull();
  });
});

describe('apply', () => {
  it('writes the proposal\u2019s stored document and appends a revision for it', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);
    await store.decide(scope, proposal.id, 'accepted');

    const result = await store.apply(scope, proposal.id);

    expect(result?.outcome).toBe('applied');
    expect(result?.irDigestBefore).toBe(irDigest(document()));
    expect(result?.irDigestAfter).toBe(irDigest(proposal.patchedIr));
    expect(result?.proposal.appliedIrDigest).toBe(result?.irDigestAfter);

    // Byte for byte what was previewed, and nothing recomputed on the way in.
    const after = await store.experiment(scope);
    expect(after.ir).toEqual(proposal.patchedIr);

    const revisions = await listRevisions(scope.userId, scope.experimentId);
    expect(revisions).toHaveLength(2);
    expect(revisions[0].source).toBe('copilot_patch');
    // A human accepting a copilot suggestion is a human-authored copilot_patch.
    expect(revisions[0].authorKind).toBe('human');
    expect(revisions[0].authorUserId).toBe(user.id);
  });

  it('is the same answer the second time, and writes nothing more', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);
    await store.decide(scope, proposal.id, 'accepted');
    const first = await store.apply(scope, proposal.id);

    const second = await store.apply(scope, proposal.id);

    expect(second?.outcome).toBe('already_applied');
    expect(second?.irDigestAfter).toBe(first?.irDigestAfter);
    expect(await listRevisions(scope.userId, scope.experimentId)).toHaveLength(2);
  });

  it('refuses a proposal the user has not accepted', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);

    const result = await store.apply(scope, proposal.id);

    expect(result?.outcome).toBe('awaiting_user_acceptance');
    expect((await store.experiment(scope)).irDigest).toBe(irDigest(document()));
  });

  it('refuses a proposal the user rejected', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);
    await store.decide(scope, proposal.id, 'rejected');

    const result = await store.apply(scope, proposal.id);

    expect(result?.outcome).toBe('rejected_by_user');
    expect((await store.experiment(scope)).irDigest).toBe(irDigest(document()));
  });

  it('refuses a proposal whose base document has moved', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);
    await store.decide(scope, proposal.id, 'accepted');

    // A canvas edit between the pricing and the click: the proposal describes a
    // document that no longer exists, and its preview priced that one.
    const moved = document();
    moved.name = 'Renamed since';
    const [head] = await listRevisions(scope.userId, scope.experimentId);
    await appendRevision(user.id, {
      experimentId: scope.experimentId,
      parentId: head.id,
      ir: moved,
      irVersion: IR_VERSION,
      summary: 'Rename the architecture',
      source: 'canvas_edit',
      authorKind: 'human',
      authorUserId: user.id,
    });

    const result = await store.apply(scope, proposal.id);

    expect(result?.outcome).toBe('stale');
    expect(result?.irDigestBefore).toBe(irDigest(moved));
    expect((await store.experiment(scope)).ir).toEqual(moved);
  });

  it('returns null for a proposal that does not exist', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    expect(await store.apply(scope, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await store.apply(scope, 'not-a-uuid')).toBeNull();
  });

  it('lets exactly one of two concurrent applies of one proposal win', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const proposal = await propose(scope);
    await store.decide(scope, proposal.id, 'accepted');

    const outcomes = (
      await Promise.all([store.apply(scope, proposal.id), store.apply(scope, proposal.id)])
    ).map((result) => result?.outcome);

    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already_applied')).toHaveLength(1);
    expect(await listRevisions(scope.userId, scope.experimentId)).toHaveLength(2);
  });

  it('applies one of two accepted proposals racing against one document', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    const first = await propose(scope, [MULTI_AZ]);
    const second = await propose(scope, [SCALE_OUT]);
    await store.decide(scope, first.id, 'accepted');
    await store.decide(scope, second.id, 'accepted');

    const outcomes = (
      await Promise.all([store.apply(scope, first.id), store.apply(scope, second.id)])
    ).map((result) => result?.outcome);

    // Both were priced against the same document, so the loser is stale rather
    // than applied on top of a change it never saw.
    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'stale')).toHaveLength(1);
    expect(await listRevisions(scope.userId, scope.experimentId)).toHaveLength(2);
  });

  it('refuses to apply through another user\u2019s experiment', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await makeExperiment(alice.id);
    const proposal = await propose(hers);
    await store.decide(hers, proposal.id, 'accepted');

    const asBob = store.apply({ experimentId: hers.experimentId, userId: bob.id }, proposal.id);

    await expect(asBob).rejects.toBeInstanceOf(ExperimentNotFoundError);
    expect((await store.experiment(hers)).irDigest).toBe(irDigest(document()));
  });
});

describe('database invariants', () => {
  /** The insert the adapter performs, written here so the table answers for itself. */
  async function insertDirectly(scope: CopilotScope, patchDigest: string, status = 'proposed') {
    return query(
      `INSERT INTO copilot_proposals
         (experiment_id, user_id, patch_digest, based_on_ir_digest, patch, inverse,
          patched_ir, preview, status, rationale, decided_at)
       VALUES ($1, $2, $3, 'base', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               $4::copilot_proposal_status, 'because',
               CASE WHEN $4 = 'proposed' THEN NULL ELSE now() END)`,
      [scope.experimentId, scope.userId, patchDigest, status]
    );
  }

  it('refuses a second open proposal for the same bytes', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    await insertDirectly(scope, 'the-same-bytes');

    await expect(insertDirectly(scope, 'the-same-bytes')).rejects.toThrow(
      /copilot_proposals_open_idx/
    );
  });

  it('accepts the same bytes again once the first is no longer open', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    await insertDirectly(scope, 'the-same-bytes', 'rejected');

    await expect(insertDirectly(scope, 'the-same-bytes')).resolves.toBeTruthy();
  });

  it('refuses an applied proposal that does not say what the document became', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);

    await expect(insertDirectly(scope, 'applied-with-no-digest', 'applied')).rejects.toThrow(
      /copilot_proposals_applied_ck/
    );
  });

  it('removes an experiment\u2019s proposals with the experiment', async () => {
    const user = await makeUser();
    const scope = await makeExperiment(user.id);
    await propose(scope);

    await query('DELETE FROM experiments WHERE id = $1', [scope.experimentId]);

    expect(await countProposals()).toBe(0);
  });
});

describe('the migration', () => {
  /** The `migrate:up` and `migrate:down` halves of the migration under test. */
  function migrationSections(): { up: string; down: string } {
    const sql = readFileSync(
      new URL('../../../../../db/migrations/20260812220000_copilot_proposals.sql', import.meta.url),
      'utf8'
    );
    const [, up, down] = /-- migrate:up([\s\S]*?)-- migrate:down([\s\S]*)$/.exec(sql) ?? [];
    if (!up || !down) throw new Error('Could not split the migration into up and down sections');
    return { up, down };
  }

  async function tableExists(name: string): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS exists`,
      [`public.${name}`]
    );
    return result.rows[0].exists;
  }

  it('rolls back and reapplies', async () => {
    const { up, down } = migrationSections();

    try {
      await query(down);

      expect(await tableExists('copilot_proposals')).toBe(false);
      expect(await tableExists('copilot_messages')).toBe(false);
      expect(await tableExists('copilot_conversations')).toBe(false);

      await query(up);

      expect(await tableExists('copilot_proposals')).toBe(true);
      expect(await tableExists('copilot_messages')).toBe(true);
    } finally {
      // Leave the schema as the rest of the suite expects to find it, whatever
      // happened above.
      await query('TRUNCATE users CASCADE');
      if (!(await tableExists('copilot_proposals'))) await query(up);
    }
  });
});
