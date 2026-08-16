import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { agentLoopApi, type LoopEvent, type LoopRun } from '@/lib/api/agent-loop';
import { ApiError } from '@/lib/api/client';
import { agentName, duration, phaseLabel, relativeTime, statusTone } from '@/lib/agent-loop/format';

// This dashboard tracks the loop building this repository, so a PR number maps
// to a known GitHub slug. Kept here as the single place that assumption lives.
const REPO_SLUG = 'johnbekele/infracanvas';

const LEVEL_TONE: Record<LoopEvent['level'], string> = {
  info: 'text-gray-500 dark:text-gray-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

function EventFeed({ issue, lastCursor }: { issue: number; lastCursor: number }) {
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Refetch whenever the board reports new activity (lastCursor advanced), so the
  // feed follows the run without a poll of its own.
  useEffect(() => {
    let cancelled = false;
    agentLoopApi
      .getEvents(issue)
      .then((fetched) => {
        if (!cancelled) setEvents(fetched);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this run’s events.');
      });
    return () => {
      cancelled = true;
    };
  }, [issue, lastCursor]);

  if (error) return <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (events.length === 0)
    return <p className="px-4 py-3 text-sm text-gray-500">No events recorded yet.</p>;

  return (
    <div className="max-h-72 space-y-1 overflow-y-auto px-4 py-3 font-mono text-xs">
      {events.map((event) => (
        <div key={event.cursor} className="flex gap-2">
          <span className="shrink-0 text-gray-400">{relativeTime(event.at)}</span>
          <span className="shrink-0 uppercase text-gray-400">{event.phase}</span>
          <span className={LEVEL_TONE[event.level]}>{event.message}</span>
        </div>
      ))}
    </div>
  );
}

export function RunCard({ run }: { run: LoopRun }) {
  const [expanded, setExpanded] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [released, setReleased] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stale = run.status === 'failed' || run.status === 'abandoned';

  const release = async () => {
    setReleasing(true);
    setError(null);
    try {
      const { released: didRelease } = await agentLoopApi.release(run.issue);
      setReleased(didRelease);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not release the claim.');
    } finally {
      setReleasing(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <span className="text-gray-400">{expanded ? '▾' : '▸'}</span>
          <span className="font-medium text-gray-900 dark:text-white">#{run.issue}</span>
        </button>

        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          Lane {run.lane} · {agentName(run.agent)}
        </span>

        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusTone(run.status)}`}>
          {run.status}
        </span>

        {run.status === 'running' && (
          <span className="text-xs text-gray-500">
            {phaseLabel(run.phase)} · {duration(run.startedAt, run.endedAt)}
          </span>
        )}

        {run.prNumber !== null && (
          <a
            href={`https://github.com/${REPO_SLUG}/pull/${run.prNumber}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            PR #{run.prNumber}
          </a>
        )}

        <div className="ml-auto flex items-center gap-2">
          {stale && !released && (
            <Button size="sm" variant="outline" onClick={release} disabled={releasing}>
              {releasing ? 'Releasing…' : 'Release'}
            </Button>
          )}
          {released && <span className="text-xs text-gray-500">Claim released</span>}
        </div>
      </div>

      {run.lastMessage && !expanded && (
        <p className="truncate px-4 pb-2 text-xs text-gray-500 dark:text-gray-400">
          {run.lastMessage}
        </p>
      )}

      {error && <p className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-800">
          <EventFeed issue={run.issue} lastCursor={run.lastCursor} />
        </div>
      )}
    </div>
  );
}
