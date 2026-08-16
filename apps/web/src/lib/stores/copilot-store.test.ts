import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CopilotEvent, CopilotMessage } from '@/lib/copilot/types';
import fixture from '@/lib/copilot/__fixtures__/turn.events.json';
import { flushCopilotTokensForTests, useCopilotStore } from './copilot-store';

const emptyAssistant = (id: string): CopilotMessage => ({
  id,
  role: 'assistant',
  content: '',
  toolCalls: [],
  citations: [],
  proposal: null,
  status: 'streaming',
  unverifiedCitations: 0,
});

afterEach(() => {
  flushCopilotTokensForTests();
  useCopilotStore.getState().reset();
  vi.useRealTimers();
});

describe('copilot-store', () => {
  it('appends streaming tokens to the open message only', async () => {
    vi.useFakeTimers();
    const store = useCopilotStore.getState();
    store.loadTranscript([
      {
        id: 'user-1',
        role: 'user',
        content: 'hi',
        toolCalls: [],
        citations: [],
        proposal: null,
        status: 'complete',
        unverifiedCitations: 0,
      },
      emptyAssistant('asst-1'),
    ]);

    store.applyEvent({ kind: 'token', seq: 1, text: 'Hel' });
    store.applyEvent({ kind: 'token', seq: 2, text: 'lo' });
    await vi.runAllTimersAsync();
    flushCopilotTokensForTests();

    const messages = useCopilotStore.getState().messages;
    expect(messages.find((m) => m.id === 'asst-1')?.content).toBe('Hello');
    expect(messages.find((m) => m.id === 'user-1')?.content).toBe('hi');
  });

  it('replaces the open message when a snapshot arrives', () => {
    const store = useCopilotStore.getState();
    store.applySnapshot(emptyAssistant('asst-1'));
    store.applyEvent({ kind: 'token', seq: 1, text: 'stale' });
    flushCopilotTokensForTests();

    store.applySnapshot({
      ...emptyAssistant('asst-1'),
      content: 'from server',
      status: 'streaming',
    });

    expect(useCopilotStore.getState().messages[0]?.content).toBe('from server');
  });

  it('records a proposal against the message that produced it', () => {
    const store = useCopilotStore.getState();
    store.applySnapshot(emptyAssistant('asst-1'));
    const event = fixture.events.find((e) => e.kind === 'patch_proposed') as CopilotEvent;
    store.applyEvent(event);

    const proposal = useCopilotStore.getState().messages[0]?.proposal;
    expect(proposal?.proposalId).toBe('prop-1');
    expect(proposal?.operations).toEqual(['Set multiAz to true on database-primary']);
    expect(useCopilotStore.getState().highlightedNodeIds).toEqual(['database-primary']);
  });

  it('clears the highlight when a proposal is rejected', () => {
    const store = useCopilotStore.getState();
    store.applySnapshot(emptyAssistant('asst-1'));
    store.applyEvent(fixture.events.find((e) => e.kind === 'patch_proposed') as CopilotEvent);
    expect(useCopilotStore.getState().highlightedNodeIds).toEqual(['database-primary']);

    store.decideProposal('prop-1', 'rejected');
    expect(useCopilotStore.getState().highlightedNodeIds).toEqual([]);
    expect(useCopilotStore.getState().messages[0]?.proposal?.decision).toBe('rejected');
  });

  it('refuses a second decision on an already decided proposal', () => {
    const store = useCopilotStore.getState();
    store.applySnapshot(emptyAssistant('asst-1'));
    store.applyEvent(fixture.events.find((e) => e.kind === 'patch_proposed') as CopilotEvent);
    store.decideProposal('prop-1', 'rejected');
    store.decideProposal('prop-1', 'accepted');

    expect(useCopilotStore.getState().messages[0]?.proposal?.decision).toBe('rejected');
  });

  it('builds the same message from the recorded fixture as the transcript returns', () => {
    const store = useCopilotStore.getState();
    store.applySnapshot(emptyAssistant('msg-assistant-1'));

    for (const event of fixture.events as CopilotEvent[]) {
      store.applyEvent(event);
      if (event.kind === 'token') flushCopilotTokensForTests();
    }
    flushCopilotTokensForTests();

    const message = useCopilotStore.getState().messages.find((m) => m.id === 'msg-assistant-1');
    expect(message).toEqual(fixture.transcriptMessage);
  });

  it('coalesces a burst of tokens into far fewer subscriber notifications', async () => {
    vi.useFakeTimers();
    let notifications = 0;
    const unsubscribe = useCopilotStore.subscribe(() => {
      notifications += 1;
    });

    useCopilotStore.getState().applySnapshot(emptyAssistant('asst-1'));
    notifications = 0;

    for (let i = 0; i < 1000; i++) {
      useCopilotStore.getState().applyEvent({ kind: 'token', seq: i + 1, text: 'x' });
    }
    await vi.runAllTimersAsync();
    flushCopilotTokensForTests();
    unsubscribe();

    expect(notifications).toBeLessThan(20);
    expect(useCopilotStore.getState().messages[0]?.content.length).toBe(1000);
  });
});
