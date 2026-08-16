import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { copilotDeps, type CopilotDeps } from './deps.js';
import type { CopilotEvent } from './events.js';
import { InMemoryCopilotStore } from './memory-store.js';
import { localPreviewPlane } from './preview-plane.js';
import { MAX_PROPOSALS_PER_TURN, MAX_TOOL_CALLS, checkPreconditions, runTurn } from './run.js';
import { scriptedModel, text, toolCall, type ScriptedRound } from './scripted-model.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const EXPERIMENT = '33333333-3333-4333-8333-333333333333';
const scope = { experimentId: EXPERIMENT, userId: OWNER };

const MULTI_AZ = { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true };

function threeTier(): ArchitectureIr {
  const ir = JSON.parse(
    readFileSync(
      new URL('../../../../../packages/ir-schema/fixtures/three-tier.json', import.meta.url),
      'utf8'
    )
  ) as ArchitectureIr;
  // The only region with a committed price list, so the turns below produce
  // real figures rather than an unpriced architecture.
  return { ...ir, region: 'us-east-1' }; // infracanvas-allow: no-hardcoded-region
}

let store: InMemoryCopilotStore;
let deps: CopilotDeps;

beforeEach(() => {
  store = new InMemoryCopilotStore([
    { id: EXPERIMENT, userId: OWNER, name: 'shop', ir: threeTier() },
  ]);
  deps = copilotDeps(scope, store, localPreviewPlane());
});

async function play(rounds: ScriptedRound[], cancelled?: () => boolean): Promise<CopilotEvent[]> {
  const model = scriptedModel(rounds);
  const context = await checkPreconditions(deps, { model, modelName: 'scripted' });
  if ('code' in context) throw new Error(`refused: ${context.code}`);

  const events: CopilotEvent[] = [];
  for await (const event of runTurn(
    context,
    { message: 'Make it survive an AZ failure', history: [] },
    cancelled
  )) {
    events.push(event);
  }
  return events;
}

function kinds(events: CopilotEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe('the preconditions of a turn', () => {
  it('refuses a turn with no model rather than opening a stream', async () => {
    const refusal = await checkPreconditions(deps, null);

    expect(refusal).toMatchObject({ code: 'no_llm_credential', status: 409 });
    // The message is an instruction, because the user has to go and do
    // something before asking again.
    expect((refusal as { message: string }).message).toContain('Settings');
  });

  it('refuses another user\u2019s experiment as a not-found', async () => {
    const stranger = copilotDeps(
      { experimentId: EXPERIMENT, userId: '22222222-2222-4222-8222-222222222222' },
      store,
      localPreviewPlane()
    );

    const refusal = await checkPreconditions(stranger, {
      model: scriptedModel([]),
      modelName: 'scripted',
    });

    expect(refusal).toMatchObject({ code: 'experiment_not_found', status: 404 });
  });

  it('refuses an experiment with nothing drawn on it', async () => {
    store.put({
      id: EXPERIMENT,
      userId: OWNER,
      name: 'empty',
      ir: { ...threeTier(), nodes: [], edges: [] },
    });

    const refusal = await checkPreconditions(deps, {
      model: scriptedModel([]),
      modelName: 'scripted',
    });

    expect(refusal).toMatchObject({ code: 'no_architecture', status: 409 });
  });
});

describe('a turn', () => {
  it('streams tokens and finishes with done', async () => {
    const events = await play([text('Multi-AZ ', 'raises the cost.')]);

    expect(kinds(events)).toEqual(['token', 'token', 'done']);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.at(-1)).toMatchObject({ finish: 'complete', toolCalls: 0 });
  });

  it('numbers every event with a strictly increasing sequence', async () => {
    const events = await play([[toolCall('c1', 'read_architecture', {})], text('Six resources.')]);

    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('calls a tool, reports it in English and never streams its arguments', async () => {
    const events = await play([
      [toolCall('c1', 'price_change', { ops: [MULTI_AZ] })],
      text('That is the delta.'),
    ]);

    const call = events.find((event) => event.kind === 'tool_call');
    const result = events.find((event) => event.kind === 'tool_result');

    expect(call).toMatchObject({
      tool: 'price_change',
      summary: 'Pricing a change of 1 operation',
    });
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(events)).not.toContain('"ops"');
  });

  it('emits patch_proposed with the preview the user will decide on', async () => {
    const events = await play([
      [
        toolCall('c1', 'propose_patch', {
          ops: [MULTI_AZ],
          summary: 'Make the database Multi-AZ',
          rationale: 'It is the weakest resource on the path.',
        }),
      ],
      text('Shall I apply that?'),
    ]);

    const proposed = events.find((event) => event.kind === 'patch_proposed');
    expect(proposed).toBeDefined();
    expect(proposed).toMatchObject({ touchedNodeIds: ['rds-primary'] });
    // The architecture itself is untouched: a proposal is a card, not a write.
    expect((await store.experiment(scope)).irDigest).toBe(
      (proposed as { preview: { basedOnIrDigest: string } }).preview.basedOnIrDigest
    );
  });

  it('returns a refused patch to the model as problems rather than ending the turn', async () => {
    const events = await play([
      [
        toolCall('c1', 'propose_patch', {
          ops: [{ op: 'remove_node', nodeId: 'rds-primary' }],
          summary: 'Delete the database',
          rationale: 'Testing a bad operation order.',
        }),
      ],
      text('That will not work because the edges reach it.'),
    ]);

    expect(kinds(events)).toContain('tool_result');
    expect(kinds(events)).not.toContain('patch_proposed');
    expect(events.at(-1)).toMatchObject({ finish: 'complete' });
  });

  it('stops at the tool ceiling with a limit event and what it already said', async () => {
    const looping: ScriptedRound[] = Array.from({ length: MAX_TOOL_CALLS + 4 }, (_, index) => [
      toolCall(`c${index}`, 'price_change', { ops: [MULTI_AZ] }),
    ]);

    const events = await play(looping);

    const limit = events.find((event) => event.kind === 'limit');
    expect(limit).toMatchObject({ limit: 'tool_calls' });
    expect(events.at(-1)).toMatchObject({ finish: 'limit' });
    expect(events.filter((event) => event.kind === 'tool_call').length).toBeLessThanOrEqual(
      MAX_TOOL_CALLS
    );
  });

  it('stops after three proposals in one turn', async () => {
    const proposal = (index: number): ScriptedRound => [
      toolCall(`c${index}`, 'propose_patch', {
        ops: [{ ...MULTI_AZ, param: 'backupRetentionDays', value: index + 1 }],
        summary: `Change ${index}`,
        rationale: 'Trying several things.',
      }),
    ];

    const events = await play([0, 1, 2, 3, 4].map(proposal));

    expect(events.find((event) => event.kind === 'limit')).toMatchObject({ limit: 'proposals' });
    expect(events.filter((event) => event.kind === 'patch_proposed')).toHaveLength(
      MAX_PROPOSALS_PER_TURN
    );
  });

  it('stops when the caller has gone and says the turn was cancelled', async () => {
    let served = 0;
    const events = await play([text('One ', 'two ', 'three ', 'four'), text('more')], () => {
      served += 1;
      // Gone by the time the second chunk is handled.
      return served > 2;
    });

    expect(events.at(-1)).toMatchObject({ finish: 'cancelled' });
    expect(kinds(events)).toContain('token');
  });

  it('reports a provider failure as a message this process wrote', async () => {
    const failing = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<never> {
        throw new Error('The model provider refused the request (401).');
      },
    };
    const context = await checkPreconditions(deps, { model: failing, modelName: 'scripted' });
    if ('code' in context) throw new Error('should not refuse');

    const events: CopilotEvent[] = [];
    for await (const event of runTurn(context, { message: 'hello', history: [] })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({ kind: 'error', code: 'provider_error' });
    expect(events.at(-1)).toMatchObject({ finish: 'error' });
    // The status, never the provider's body: one of those carries the request
    // it rejected, and the request carries the architecture.
    expect(JSON.stringify(events)).not.toContain('rds-primary');
  });

  it('drops the oldest history first and says that it did', async () => {
    const model = scriptedModel([text('Answering.')]);
    const context = await checkPreconditions(deps, { model, modelName: 'scripted' });
    if ('code' in context) throw new Error('should not refuse');

    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `Message ${index}`,
    }));
    for await (const _event of runTurn(context, { message: 'And now?', history })) void _event;

    const sent = model.requests[0].messages;
    expect(sent.some((message) => message.content.includes('were dropped to fit'))).toBe(true);
    expect(sent.some((message) => message.content === 'Message 0')).toBe(false);
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'And now?' });
  });
});
