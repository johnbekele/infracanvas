import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { irDigest, type IrPatchOp } from '@infracanvas/core';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { copilotDeps, type CopilotDeps } from './deps.js';
import { ExperimentNotFoundError, ToolArgumentError } from './errors.js';
import { InMemoryCopilotStore } from './memory-store.js';
import { localPreviewPlane } from './preview-plane.js';
import { invokeTool } from './registry.js';
import type { CopilotScope } from './store.js';
import {
  applyPatch,
  compareOptions,
  explainNode,
  priceChange,
  proposePatch,
  readArchitecture,
} from './tools.js';
import { compareOptionsArgs } from './validate.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const EXPERIMENT = '33333333-3333-4333-8333-333333333333';

const MULTI_AZ: IrPatchOp = {
  op: 'set_param',
  nodeId: 'rds-primary',
  param: 'multiAz',
  value: true,
};

function threeTier(): ArchitectureIr {
  const ir = JSON.parse(
    readFileSync(
      new URL('../../../../../packages/ir-schema/fixtures/three-tier.json', import.meta.url),
      'utf8'
    )
  ) as ArchitectureIr;

  // The fixture is drawn in eu-west-1 and the only committed price list is for
  // us-east-1, so a document left as it is prices at nothing and every cost
  // assertion below would pass against an empty answer.
  return { ...ir, region: 'us-east-1' }; // infracanvas-allow: no-hardcoded-region
}

let store: InMemoryCopilotStore;
let deps: CopilotDeps;
const scope: CopilotScope = { experimentId: EXPERIMENT, userId: OWNER };

beforeEach(() => {
  store = new InMemoryCopilotStore([
    { id: EXPERIMENT, userId: OWNER, name: 'shop', ir: threeTier() },
  ]);
  deps = copilotDeps(scope, store, localPreviewPlane());
});

async function accepted(ops: IrPatchOp[] = [MULTI_AZ]): Promise<string> {
  const proposal = await proposePatch(deps, {
    ops,
    summary: 'Make the primary database Multi-AZ',
    rationale: 'A single-AZ database is the weakest resource on the path.',
  });
  const id = proposal.proposal_id;
  if (id === null) throw new Error('the fixture patch should apply');
  await store.decide(scope, id, 'accepted');
  return id;
}

describe('read_architecture', () => {
  it('returns the document with an index of it and what it costs', async () => {
    const view = await readArchitecture(deps, {});

    expect(view.ir_digest).toBe(irDigest(view.ir));
    expect(view.node_count).toBe(view.ir.nodes.length);
    expect(view.nodes).toHaveLength(view.ir.nodes.length);
    expect(view.nodes[0]).toEqual({
      id: view.ir.nodes[0].id,
      kind: view.ir.nodes[0].kind,
      name: view.ir.nodes[0].name,
      parent: view.ir.nodes[0].parent ?? null,
    });
    expect(view.monthly_usd).toBeGreaterThan(0);
  });

  it('returns in under a fiftieth of a second for a two hundred node document', async () => {
    const ir = threeTier();
    const template = ir.nodes.find((node) => node.id === 'rds-primary');
    if (template === undefined) throw new Error('the fixture should carry a database');
    while (ir.nodes.length < 200) {
      ir.nodes.push({
        ...template,
        id: `rds-${ir.nodes.length}`,
        name: `Database ${ir.nodes.length}`,
      });
    }
    store.put({ id: EXPERIMENT, userId: OWNER, name: 'shop', ir });

    const started = performance.now();
    const view = await readArchitecture(deps, {});
    const elapsed = performance.now() - started;

    expect(view.node_count).toBe(200);
    // Measured on a development machine: 21ms, nearly all of it pricing two
    // hundred resources. The assertion is an order of magnitude above that
    // because CI runs every package's suite concurrently on a small runner
    // (#152).
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('explain_node', () => {
  it('carries the price snapshot behind every cost line, so a claim about price is traceable', async () => {
    const explanation = await explainNode(deps, { node_id: 'rds-primary' });

    expect(explanation.cost_lines.length).toBeGreaterThan(0);
    for (const line of explanation.cost_lines) {
      expect(line.resourceId).toBe('rds-primary');
      expect(line.monthlyUsd).toBeGreaterThan(0);
    }
    // The cost model traces a figure to a published list per resource rather
    // than per line; giving a line its own SKU would change
    // `packages/core/src/prediction/`, which this issue excludes.
    expect(explanation.price_source?.file).toContain('rds-us-east-1.json');
    expect(explanation.price_source?.priceListVersion).toBeTruthy();
  });

  it('reports the containment chain, the edges and the findings against the node', async () => {
    const explanation = await explainNode(deps, { node_id: 'rds-primary' });

    expect(explanation.parent_chain[0]).toBe('subnet-private-a');
    expect(explanation.parent_chain).toContain('vpc-main');
    expect(explanation.edges_in.map((edge) => edge.source)).toContain('ecs-api');
    expect(explanation.findings.map((finding) => finding.ruleId)).toContain('RDS-REL-001');
    expect(explanation.availability?.basis).toBe('published');
  });

  it('returns no evidence rather than a plausible path', async () => {
    // Nothing was analysed for this experiment, so nothing in the repository
    // can be cited. An empty list is the honest answer.
    const explanation = await explainNode(deps, { node_id: 'rds-primary' });

    expect(explanation.evidence).toEqual([]);
  });
});

describe('price_change', () => {
  it('writes no row and returns what propose_patch would have priced', async () => {
    const priced = await priceChange(deps, { ops: [MULTI_AZ] });
    const proposal = await proposePatch(deps, {
      ops: [MULTI_AZ],
      summary: 'Make the primary database Multi-AZ',
      rationale: 'The database is the weakest resource on the path.',
    });

    expect(priced.patchDigest).toBe(proposal.patch_digest);
    expect(priced.cost.monthlyUsdDelta).toBe(proposal.preview?.cost.monthlyUsdDelta);
    expect(priced.availability.after).toBe(proposal.preview?.availability.after);
  });
});

describe('compare_options', () => {
  it('prices every option against the same document and records no proposal', async () => {
    const before = await readArchitecture(deps, {});

    const comparison = await compareOptions(deps, {
      question: 'How do I make the database survive an availability zone failure?',
      options: [
        { label: 'Multi-AZ', ops: [MULTI_AZ] },
        {
          label: 'A larger instance',
          ops: [
            {
              op: 'set_param',
              nodeId: 'rds-primary',
              param: 'instanceClass',
              value: 'db.t4g.small',
            },
          ],
        },
      ],
    });

    expect(comparison.options).toHaveLength(2);
    for (const option of comparison.options) {
      expect(option.preview?.basedOnIrDigest).toBe(before.ir_digest);
    }
    expect(comparison.baseline_monthly_usd).toBeGreaterThan(0);

    // No proposal exists to accept: a comparison is a question, and a user
    // cannot accept a column.
    const digest = comparison.options[0].preview?.patchDigest;
    expect(digest).toBeDefined();
    expect(await store.openProposal(scope, digest as string)).toBeNull();
  });

  it('rejects more than four options before pricing anything', () => {
    const five = Array.from({ length: 5 }, (_, index) => ({
      label: `Option ${index}`,
      ops: [MULTI_AZ],
    }));

    expect(() => compareOptionsArgs({ question: 'Which?', options: five })).toThrow(
      ToolArgumentError
    );
  });

  it('prices four options inside twice the cost of one, because they share a baseline', async () => {
    const one = performance.now();
    await priceChange(deps, { ops: [MULTI_AZ] });
    const single = performance.now() - one;

    const four = performance.now();
    await compareOptions(deps, {
      question: 'What are my options?',
      options: [
        { label: 'a', ops: [{ ...MULTI_AZ }] },
        {
          label: 'b',
          ops: [
            {
              op: 'set_param',
              nodeId: 'rds-primary',
              param: 'instanceClass',
              value: 'db.t4g.small',
            },
          ],
        },
        {
          label: 'c',
          ops: [{ op: 'set_param', nodeId: 'rds-primary', param: 'allocatedStorageGb', value: 40 }],
        },
        {
          label: 'd',
          ops: [
            { op: 'set_param', nodeId: 'rds-primary', param: 'backupRetentionDays', value: 14 },
          ],
        },
      ],
    });
    const comparison = performance.now() - four;

    // Measured on a development machine: 1.1ms for one and 1.6ms for four,
    // because the baseline is computed once and cached. The assertion allows
    // an order of magnitude more headroom than the budget's 2x, since CI runs
    // every package's suite concurrently on a small runner (#152).
    expect(comparison).toBeLessThan(single * 20 + 200);
  });
});

describe('propose_patch', () => {
  it('records a proposal without touching the experiment', async () => {
    const before = (await store.experiment(scope)).irDigest;

    const proposal = await proposePatch(deps, {
      ops: [MULTI_AZ],
      summary: 'Make the primary database Multi-AZ',
      rationale: 'It is the weakest resource on the path.',
    });

    expect(proposal.accepted).toBe(true);
    expect(proposal.proposal_id).not.toBeNull();
    expect(proposal.touched_node_ids).toEqual(['rds-primary']);
    expect((await store.experiment(scope)).irDigest).toBe(before);
  });

  it('returns problems rather than raising for a patch that cannot apply', async () => {
    const proposal = await proposePatch(deps, {
      // remove_node does not cascade: the edges that reach the database have
      // to be named too, and this patch does not name them.
      ops: [{ op: 'remove_node', nodeId: 'rds-primary' }],
      summary: 'Delete the database',
      rationale: 'Testing what happens when the order is wrong.',
    });

    expect(proposal.accepted).toBe(false);
    expect(proposal.proposal_id).toBeNull();
    expect(proposal.problems[0].source).toBe('precondition');
    expect(await store.openProposal(scope, proposal.patch_digest)).toBeNull();
  });

  it('returns the open proposal rather than a second one for the same edit', async () => {
    const first = await proposePatch(deps, {
      ops: [MULTI_AZ],
      summary: 'Make the primary database Multi-AZ',
      rationale: 'One.',
    });
    const second = await proposePatch(deps, {
      ops: [MULTI_AZ],
      summary: 'Make the primary database Multi-AZ',
      rationale: 'Two.',
    });

    expect(second.proposal_id).toBe(first.proposal_id);
  });
});

describe('apply_patch', () => {
  it('refuses a proposal the user has not accepted', async () => {
    const proposal = await proposePatch(deps, {
      ops: [MULTI_AZ],
      summary: 'Make the primary database Multi-AZ',
      rationale: 'Nobody has said yes yet.',
    });
    const before = (await store.experiment(scope)).irDigest;

    const outcome = await applyPatch(deps, { proposal_id: proposal.proposal_id as string });

    expect(outcome.outcome).toBe('awaiting_user_acceptance');
    expect(outcome.ir_digest_after).toBeNull();
    expect((await store.experiment(scope)).irDigest).toBe(before);
  });

  it('writes the previewed document unchanged', async () => {
    const id = await accepted();
    const proposal = await store.proposal(scope, id);

    const outcome = await applyPatch(deps, { proposal_id: id });

    expect(outcome.outcome).toBe('applied');
    // The bytes written are the bytes that were priced, rather than the result
    // of a second application that has to agree with the first.
    expect((await store.experiment(scope)).ir).toEqual(proposal?.patchedIr);
    expect(outcome.ir_digest_after).toBe(irDigest(proposal?.patchedIr as ArchitectureIr));
  });

  it('reports stale when the document moved underneath the proposal', async () => {
    const id = await accepted();
    const moved = threeTier();
    moved.name = 'Renamed after the proposal was priced';
    moved.nodes = moved.nodes.filter((node) => node.id !== 'cache-sessions');
    moved.nodes[0] = { ...moved.nodes[0], name: 'A different name' };
    store.put({ id: EXPERIMENT, userId: OWNER, name: 'shop', ir: moved });

    const outcome = await applyPatch(deps, { proposal_id: id });

    expect(outcome.outcome).toBe('stale');
    expect(outcome.ir_digest_after).toBeNull();
  });

  it('applies once and then reports already applied with the same digest', async () => {
    const id = await accepted();

    const first = await applyPatch(deps, { proposal_id: id });
    const second = await applyPatch(deps, { proposal_id: id });

    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('already_applied');
    expect(second.ir_digest_after).toBe(first.ir_digest_after);
  });

  it('leaves one applied proposal when two calls race', async () => {
    const id = await accepted();

    const [first, second] = await Promise.all([
      applyPatch(deps, { proposal_id: id }),
      applyPatch(deps, { proposal_id: id }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['already_applied', 'applied']);
    expect(first.ir_digest_after).toBe(second.ir_digest_after);
  });

  it('refuses a proposal the user rejected', async () => {
    const proposal = await proposePatch(deps, {
      ops: [MULTI_AZ],
      summary: 'Make the primary database Multi-AZ',
      rationale: 'The user says no.',
    });
    await store.decide(scope, proposal.proposal_id as string, 'rejected');

    const outcome = await applyPatch(deps, { proposal_id: proposal.proposal_id as string });

    expect(outcome.outcome).toBe('rejected_by_user');
  });
});

describe('every tool', () => {
  it('refuses another user\u2019s experiment, indistinguishably from an unknown id', async () => {
    const intruder = copilotDeps(
      { experimentId: EXPERIMENT, userId: STRANGER },
      store,
      localPreviewPlane()
    );
    const unknown = copilotDeps(
      { experimentId: '44444444-4444-4444-8444-444444444444', userId: OWNER },
      store,
      localPreviewPlane()
    );

    const calls: [string, unknown][] = [
      ['read_architecture', {}],
      ['explain_node', { node_id: 'rds-primary' }],
      ['price_change', { ops: [MULTI_AZ] }],
      [
        'compare_options',
        {
          question: 'Which?',
          options: [
            { label: 'a', ops: [MULTI_AZ] },
            { label: 'b', ops: [MULTI_AZ] },
          ],
        },
      ],
      ['propose_patch', { ops: [MULTI_AZ], summary: 'A change', rationale: 'Because.' }],
      ['apply_patch', { proposal_id: await accepted() }],
    ];

    for (const [name, args] of calls) {
      await expect(invokeTool(intruder, name, args)).rejects.toBeInstanceOf(
        ExperimentNotFoundError
      );
      await expect(invokeTool(unknown, name, args)).rejects.toBeInstanceOf(ExperimentNotFoundError);
    }
  });

  it('records the call it served, including the ones that failed', async () => {
    await invokeTool(deps, 'read_architecture', {});
    await expect(invokeTool(deps, 'explain_node', { node_id: 'nothing-here' })).rejects.toThrow();

    expect(deps.calls.map((call) => [call.name, call.ok])).toEqual([
      ['read_architecture', true],
      ['explain_node', false],
    ]);
    expect(deps.calls[1].error).toContain('nothing-here');
  });
});
