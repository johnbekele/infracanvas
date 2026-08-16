/**
 * Watching the agent loop live.
 *
 * A probe fetch first tells apart the two "nothing here" cases the board would
 * otherwise conflate: the dashboard being disabled (404) versus enabled but
 * idle. Then an EventSource carries every subsequent change, so the lanes update
 * as the loop works rather than on a poll the user has to trigger.
 */
import { useEffect, useState } from 'react';
import { agentLoopApi, type LoopBoard } from '../api/agent-loop';
import { ApiError } from '../api/client';

export type Connection = 'connecting' | 'open' | 'closed';

export interface AgentLoopState {
  board: LoopBoard | null;
  /** False when the server has the dashboard turned off (a 404 on the probe). */
  enabled: boolean;
  connection: Connection;
}

export function useAgentLoop(): AgentLoopState {
  const [board, setBoard] = useState<LoopBoard | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [connection, setConnection] = useState<Connection>('connecting');

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    const open = () => {
      source = new EventSource(agentLoopApi.streamUrl(), { withCredentials: true });

      source.addEventListener('board', (event) => {
        try {
          setBoard(JSON.parse((event as MessageEvent).data) as LoopBoard);
          setConnection('open');
        } catch {
          // A malformed frame is dropped; the next good one replaces the board.
        }
      });

      source.addEventListener('error', () => {
        // EventSource reconnects on its own for a dropped connection; only a
        // terminal close is worth reflecting in the UI.
        if (source?.readyState === EventSource.CLOSED) setConnection('closed');
      });
    };

    // Probe once to detect the disabled case before opening a stream that would
    // only ever error against a 404.
    agentLoopApi
      .getBoard()
      .then((initial) => {
        if (cancelled) return;
        setBoard(initial);
        open();
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setEnabled(false);
          setConnection('closed');
          return;
        }
        // Any other failure still tries the stream, which retries on its own.
        open();
      });

    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  return { board, enabled, connection };
}
