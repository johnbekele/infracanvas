import { useCallback, useEffect, useRef, useState } from 'react';

import { TurnRefusedError, acceptProposal, fetchTranscript, rejectProposal, sendTurn } from './api';
import { applyEvent, startTurn, type Turn } from './conversation';
import type { AcceptedPatch } from './api';

interface UseConversation {
  turns: Turn[];
  isStreaming: boolean;
  /** A refusal the user can act on: no key configured, a turn already running. */
  refusal: { code: string; message: string } | null;
  send: (message: string) => void;
  stop: () => void;
  accept: (proposalId: string) => Promise<AcceptedPatch | null>;
  reject: (proposalId: string) => Promise<void>;
}

/**
 * One conversation about one experiment.
 *
 * The transcript is loaded from the server rather than kept only in this tab,
 * because a conversation about an architecture outlives the tab that started it
 * and a reload should not look like a fresh start.
 */
export function useConversation(experimentId: string | null): UseConversation {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [isStreaming, setStreaming] = useState(false);
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (experimentId === null) {
      setTurns([]);
      return;
    }

    let cancelled = false;
    void fetchTranscript(experimentId)
      .then((messages) => {
        if (cancelled) return;
        setTurns(
          messages.map((message) => ({
            ...startTurn(message.id, message.role, message.content),
            toolCalls: message.toolCalls.map((call) => ({
              callId: call.callId,
              tool: call.tool,
              summary: call.summary,
              ok: call.ok,
              durationMs: call.durationMs,
            })),
            status: message.status,
            unverifiedCitations: message.unverifiedCitations,
            lastSeq: message.lastEventSeq,
          }))
        );
      })
      .catch(() => {
        // An unreadable transcript is not worth an error banner over: the user
        // came here to ask something, and the send path reports its own failures.
      });

    return () => {
      cancelled = true;
    };
  }, [experimentId]);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    (message: string) => {
      if (experimentId === null || isStreaming) return;

      const controller = new AbortController();
      abort.current = controller;
      setRefusal(null);
      setStreaming(true);

      const assistantId = `pending_${Date.now()}`;
      setTurns((current) => [
        ...current,
        { ...startTurn(`user_${Date.now()}`, 'user', message) },
        startTurn(assistantId, 'assistant'),
      ]);

      void (async () => {
        try {
          for await (const event of sendTurn(experimentId, message, controller.signal)) {
            setTurns((current) =>
              current.map((turn) => (turn.id === assistantId ? applyEvent(turn, event) : turn))
            );
          }
        } catch (error) {
          if (error instanceof TurnRefusedError) {
            setRefusal({ code: error.refusal.code, message: error.refusal.message });
            // The empty assistant turn is removed rather than left as a blank
            // bubble: the refusal is the answer, and it is shown as one.
            setTurns((current) => current.filter((turn) => turn.id !== assistantId));
          } else if (!controller.signal.aborted) {
            setTurns((current) =>
              current.map((turn) =>
                turn.id === assistantId
                  ? { ...turn, status: 'error', note: 'The connection to the copilot dropped.' }
                  : turn
              )
            );
          }
        } finally {
          if (abort.current === controller) abort.current = null;
          setStreaming(false);
        }
      })();
    },
    [experimentId, isStreaming]
  );

  const accept = useCallback(
    async (proposalId: string) => {
      if (experimentId === null) return null;
      const applied = await acceptProposal(experimentId, proposalId);
      setTurns((current) =>
        current.map((turn) =>
          turn.proposal?.proposalId === proposalId ? { ...turn, proposal: null } : turn
        )
      );
      return applied;
    },
    [experimentId]
  );

  const reject = useCallback(
    async (proposalId: string) => {
      if (experimentId === null) return;
      await rejectProposal(experimentId, proposalId);
      setTurns((current) =>
        current.map((turn) =>
          turn.proposal?.proposalId === proposalId ? { ...turn, proposal: null } : turn
        )
      );
    },
    [experimentId]
  );

  useEffect(() => stop, [stop]);

  return { turns, isStreaming, refusal, send, stop, accept, reject };
}
