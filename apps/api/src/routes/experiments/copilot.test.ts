import { readFileSync } from 'node:fs';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { InMemoryCopilotStore } from '../../lib/copilot/memory-store.js';
import { localPreviewPlane } from '../../lib/copilot/preview-plane.js';
import { scriptedModel, text, toolCall } from '../../lib/copilot/scripted-model.js';
import { InMemoryTranscriptStore } from '../../lib/copilot/transcript.js';
import * as platform from './platform.js';
import copilotRoutes from './copilot.js';
import proposalRoutes from './proposals.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const EXPERIMENT = '33333333-3333-4333-8333-333333333333';

const MULTI_AZ = { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true };

function threeTier(): ArchitectureIr {
  const ir = JSON.parse(
    readFileSync(
      new URL('../../../../../packages/ir-schema/fixtures/three-tier.json', import.meta.url),
      'utf8'
    )
  ) as ArchitectureIr;
  return { ...ir, region: 'us-east-1' }; // infracanvas-allow: no-hardcoded-region
}

let store: InMemoryCopilotStore;
let transcript: InMemoryTranscriptStore;

/** The real router, with the session the auth middleware would have set. */
function app(userId = OWNER): Express {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.session = { userId, sessionId: 'test-session' } as never;
    next();
  });
  server.use('/experiments/:id/copilot/proposals', proposalRoutes);
  server.use('/experiments/:id/copilot', copilotRoutes);
  return server;
}

/** Frames of an SSE body, as `{ id, event, data }`. */
function frames(body: string): { id: string; event: string; data: Record<string, unknown> }[] {
  return body
    .split('\n\n')
    .filter((block) => block.includes('event:'))
    .map((block) => {
      const lines = block.split('\n');
      const find = (prefix: string) =>
        lines
          .find((line) => line.startsWith(prefix))
          ?.slice(prefix.length)
          .trim() ?? '';
      return {
        id: find('id:'),
        event: find('event:'),
        data: JSON.parse(find('data:')) as Record<string, unknown>,
      };
    });
}

beforeEach(() => {
  store = new InMemoryCopilotStore([
    { id: EXPERIMENT, userId: OWNER, name: 'shop', ir: threeTier() },
  ]);
  transcript = new InMemoryTranscriptStore();
  platform.setCopilotPlatform({ store, transcript, preview: localPreviewPlane() });
});

afterEach(() => {
  platform.setCopilotPlatform(null);
  vi.restoreAllMocks();
});

function withModel(rounds: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(rounds);
  vi.spyOn(platform, 'chatModelFor').mockResolvedValue({ model, modelName: 'scripted' });
  return model;
}

describe('POST /experiments/:id/copilot/messages', () => {
  it('streams a turn as server-sent events', async () => {
    withModel([text('Multi-AZ ', 'costs more.')]);

    const response = await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'How do I survive an AZ failure?' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('retry: 2000');

    const streamed = frames(response.text);
    expect(streamed.map((frame) => frame.event)).toEqual(['token', 'token', 'done']);
  });

  it('numbers every frame with a strictly increasing id', async () => {
    withModel([[toolCall('c1', 'read_architecture', {})], text('Six resources.')]);

    const response = await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'What is here?' });

    const ids = frames(response.text).map((frame) => frame.id);
    const messageIds = new Set(ids.map((id) => id.slice(0, id.lastIndexOf(':'))));
    const seqs = ids.map((id) => Number.parseInt(id.slice(id.lastIndexOf(':') + 1), 10));

    expect(messageIds.size).toBe(1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('returns 404 for another user\u2019s experiment before calling the model', async () => {
    const model = withModel([text('should never run')]);

    const response = await request(app(STRANGER))
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'Show me their architecture' });

    expect(response.status).toBe(404);
    expect(model.requests).toHaveLength(0);
    expect(response.headers['content-type']).not.toContain('event-stream');
  });

  it('forwards a refusal as a status code rather than an event', async () => {
    // No credential configured: the user has to add one, and the answer says
    // so as a 409 with a message rather than as an error inside a 200.
    vi.spyOn(platform, 'chatModelFor').mockResolvedValue(null);

    const response = await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'Anything' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('no_llm_credential');
    expect(response.text).not.toContain('event:');
  });

  it('refuses a second streaming turn in one conversation', async () => {
    withModel([text('one')]);
    await transcript.append(
      { experimentId: EXPERIMENT, userId: OWNER },
      { role: 'assistant', content: '', status: 'streaming' }
    );

    const response = await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'And another thing' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('turn_in_progress');
  });

  it('persists the assistant text and the tool calls it made', async () => {
    withModel([[toolCall('c1', 'price_change', { ops: [MULTI_AZ] })], text('That is the delta.')]);

    await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'What would Multi-AZ cost?' });

    const messages = await transcript.messages({ experimentId: EXPERIMENT, userId: OWNER });
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const assistant = messages[1];
    expect(assistant.content).toBe('That is the delta.');
    expect(assistant.status).toBe('complete');
    expect(assistant.toolCalls).toHaveLength(1);
    // Arguments are never stored: one of them can carry a whole patch, and the
    // proposal row already holds it.
    expect(JSON.stringify(assistant.toolCalls)).not.toContain('ops');
  });

  it('refuses an empty or oversized message', async () => {
    withModel([text('never')]);
    const server = app();

    expect(
      (await request(server).post(`/experiments/${EXPERIMENT}/copilot/messages`).send({})).status
    ).toBe(400);
    expect(
      (
        await request(server)
          .post(`/experiments/${EXPERIMENT}/copilot/messages`)
          .send({ message: 'x'.repeat(8001) })
      ).status
    ).toBe(400);
  });
});

describe('GET /experiments/:id/copilot', () => {
  it('returns the transcript in order', async () => {
    withModel([text('Answered.')]);
    await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'A question' });

    const response = await request(app()).get(`/experiments/${EXPERIMENT}/copilot`);

    expect(response.status).toBe(200);
    expect(response.body.messages.map((message: { seq: number }) => message.seq)).toEqual([1, 2]);
  });

  it('returns 404 for another user', async () => {
    const response = await request(app(STRANGER)).get(`/experiments/${EXPERIMENT}/copilot`);

    expect(response.status).toBe(404);
  });
});

describe('GET /experiments/:id/copilot/messages/:messageId/events', () => {
  it('resumes a finished message with one snapshot and a done, without blocking', async () => {
    withModel([text('All done.')]);
    await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'A question' });
    const messages = await transcript.messages({ experimentId: EXPERIMENT, userId: OWNER });
    const assistant = messages[1];

    const response = await request(app()).get(
      `/experiments/${EXPERIMENT}/copilot/messages/${assistant.id}/events`
    );

    const streamed = frames(response.text);
    expect(streamed.map((frame) => frame.event)).toEqual(['snapshot', 'done']);
    expect((streamed[0].data.message as { content: string }).content).toBe('All done.');
  });

  it('returns 404 for a message that is not this user\u2019s', async () => {
    withModel([text('All done.')]);
    await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'A question' });
    const [, assistant] = await transcript.messages({ experimentId: EXPERIMENT, userId: OWNER });

    const response = await request(app(STRANGER)).get(
      `/experiments/${EXPERIMENT}/copilot/messages/${assistant.id}/events`
    );

    expect(response.status).toBe(404);
  });
});

describe('accepting and rejecting a proposal', () => {
  async function propose(): Promise<string> {
    withModel([
      [
        toolCall('c1', 'propose_patch', {
          ops: [MULTI_AZ],
          summary: 'Make the database Multi-AZ',
          rationale: 'It is the weakest resource on the path.',
        }),
      ],
      text('Shall I?'),
    ]);
    await request(app())
      .post(`/experiments/${EXPERIMENT}/copilot/messages`)
      .send({ message: 'Make it survive an AZ failure' });

    const [, assistant] = await transcript.messages({ experimentId: EXPERIMENT, userId: OWNER });
    if (assistant.proposalId === null) throw new Error('the turn should have proposed');
    return assistant.proposalId;
  }

  it('applies a proposal once and returns the resulting digest', async () => {
    const proposalId = await propose();

    const first = await request(app()).post(
      `/experiments/${EXPERIMENT}/copilot/proposals/${proposalId}/accept`
    );
    const second = await request(app()).post(
      `/experiments/${EXPERIMENT}/copilot/proposals/${proposalId}/accept`
    );

    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('applied');
    expect(first.body.irDigest).toBeTruthy();
    // The second click is the same answer, not a second write.
    expect(second.body.outcome).toBe('already_applied');
    expect(second.body.irDigest).toBe(first.body.irDigest);
  });

  it('refuses to apply a proposal whose base document moved', async () => {
    const proposalId = await propose();
    const moved = threeTier();
    moved.nodes = moved.nodes.map((node) =>
      node.id === 'rds-primary' ? { ...node, name: 'Renamed since' } : node
    );
    store.put({ id: EXPERIMENT, userId: OWNER, name: 'shop', ir: moved });
    const before = (await store.experiment({ experimentId: EXPERIMENT, userId: OWNER })).irDigest;

    const response = await request(app()).post(
      `/experiments/${EXPERIMENT}/copilot/proposals/${proposalId}/accept`
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('stale');
    expect((await store.experiment({ experimentId: EXPERIMENT, userId: OWNER })).irDigest).toBe(
      before
    );
  });

  it('leaves the architecture byte-identical when a proposal is rejected', async () => {
    const proposalId = await propose();
    const scope = { experimentId: EXPERIMENT, userId: OWNER };
    const before = (await store.experiment(scope)).irDigest;

    const response = await request(app()).post(
      `/experiments/${EXPERIMENT}/copilot/proposals/${proposalId}/reject`
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('rejected');
    expect((await store.experiment(scope)).irDigest).toBe(before);
  });

  it('returns 404 to another user for a proposal that exists', async () => {
    const proposalId = await propose();

    const response = await request(app(STRANGER)).post(
      `/experiments/${EXPERIMENT}/copilot/proposals/${proposalId}/accept`
    );

    expect(response.status).toBe(404);
  });
});
