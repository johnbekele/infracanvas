import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { agentLoopApi, type LoopStatus } from '@/lib/api/agent-loop';
import { ApiError } from '@/lib/api/client';

/**
 * The loop's header: whether it is running, and the Start/Stop controls.
 *
 * The board arrives over SSE, so after an action the component only has to fire
 * the request; the running state and pid update themselves within a tick. Stop
 * writes the kill switch — the graceful path that lets the current agents finish
 * — so the button says "Stopping…" until the loop actually exits.
 */
export function LoopControls({ status }: { status: LoopStatus }) {
  const [pending, setPending] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: 'start' | 'stop', action: () => Promise<unknown>) => {
    setPending(which);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        className={
          status.running
            ? 'inline-flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400'
            : 'inline-flex items-center gap-2 text-sm font-medium text-gray-500'
        }
      >
        <span
          className={
            status.running
              ? 'h-2.5 w-2.5 animate-pulse rounded-full bg-green-500'
              : 'h-2.5 w-2.5 rounded-full bg-gray-400'
          }
        />
        {status.running ? `Running (pid ${status.pid ?? '?'})` : 'Stopped'}
        {status.stopRequested && status.running ? ' — stopping…' : ''}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => run('start', () => agentLoopApi.start())}
          disabled={status.running || pending !== null}
        >
          {pending === 'start' ? 'Starting…' : 'Start'}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => run('stop', () => agentLoopApi.stop())}
          disabled={!status.running || status.stopRequested || pending !== null}
        >
          {pending === 'stop' || status.stopRequested ? 'Stopping…' : 'Stop'}
        </Button>
      </div>

      {error && <p className="w-full text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
