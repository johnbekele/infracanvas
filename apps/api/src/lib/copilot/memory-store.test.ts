import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { irDigest, type IrPatch, type PatchPreview } from '@infracanvas/core';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { ExperimentNotFoundError } from './errors.js';
import { InMemoryCopilotStore } from './memory-store.js';
import type { CopilotScope, NewProposal } from './store.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const EXPERIMENT = '33333333-3333-4333-8333-333333333333';
const scope: CopilotScope = { experimentId: EXPERIMENT, userId: OWNER };

function ir(): ArchitectureIr {
  return JSON.parse(
    readFileSync(
      new URL('../../../../../packages/ir-schema/fixtures/three-tier.json', import.meta.url),
      'utf8'
    )
  ) as ArchitectureIr;
}

function proposalFor(document: ArchitectureIr): NewProposal {
  const patch: IrPatch = {
    patchVersion: 1,
    basedOnIrDigest: irDigest(document),
    summary: 'A change',
    ops: [{ op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true }],
  };
  return {
    experimentId: EXPERIMENT,
    userId: OWNER,
    patchDigest: 'digest-of-the-bytes',
    basedOnIrDigest: patch.basedOnIrDigest,
    patch,
    inverse: { ...patch, summary: 'Undo' },
    patchedIr: document,
    preview: { touchedNodeIds: ['rds-primary'] } as PatchPreview,
    rationale: 'Because the database is the weakest resource on the path.',
  };
}

let store: InMemoryCopilotStore;

beforeEach(() => {
  store = new InMemoryCopilotStore([{ id: EXPERIMENT, userId: OWNER, name: 'shop', ir: ir() }]);
});

describe('the copilot store', () => {
  it('answers an unknown experiment and another user\u2019s the same way', async () => {
    const unknown = store.experiment({ experimentId: 'nothing', userId: OWNER });
    const stranger = store.experiment({ experimentId: EXPERIMENT, userId: STRANGER });

    await expect(unknown).rejects.toBeInstanceOf(ExperimentNotFoundError);
    await expect(stranger).rejects.toBeInstanceOf(ExperimentNotFoundError);
    // Same message too: a different one would confirm which of the two it was.
    await expect(stranger).rejects.toThrow(`No experiment ${EXPERIMENT}`);
  });

  it('finds an open proposal by its digest and stops finding it once decided', async () => {
    const inserted = await store.insertProposal(scope, proposalFor(ir()));

    expect(await store.openProposal(scope, 'digest-of-the-bytes')).toMatchObject({
      id: inserted.id,
    });

    await store.decide(scope, inserted.id, 'accepted');

    // An accepted proposal is no longer the open one: proposing the same edit
    // again should produce a new card rather than reopening a decided one.
    expect(await store.openProposal(scope, 'digest-of-the-bytes')).toBeNull();
  });

  it('refuses to re-decide a proposal that was already decided', async () => {
    const inserted = await store.insertProposal(scope, proposalFor(ir()));
    await store.decide(scope, inserted.id, 'accepted');

    const again = await store.decide(scope, inserted.id, 'rejected');

    expect(again?.status).toBe('accepted');
  });

  it('does not return one user\u2019s proposal to another', async () => {
    const inserted = await store.insertProposal(scope, proposalFor(ir()));
    store.put({ id: 'other', userId: STRANGER, name: 'theirs', ir: ir() });

    const asStranger = store.proposal({ experimentId: 'other', userId: STRANGER }, inserted.id);

    await expect(asStranger).resolves.toBeNull();
  });

  it('reports nothing to apply for a proposal that does not exist', async () => {
    await expect(store.apply(scope, 'no-such-proposal')).resolves.toBeNull();
  });
});
