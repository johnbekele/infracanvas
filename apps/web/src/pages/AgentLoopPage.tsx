import { AppHeader } from '@/components/layout/AppHeader';
import { AuthMethodPicker } from '@/components/auth';
import { LoopControls } from '@/components/agent-loop/LoopControls';
import { RunCard } from '@/components/agent-loop/RunCard';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useAgentLoop } from '@/lib/hooks/use-agent-loop';
import type { Lane, LoopRun } from '@/lib/api/agent-loop';
import { agentName, laneAgent, phaseLabel } from '@/lib/agent-loop/format';

const LANES: Lane[] = ['A', 'B', 'C'];

/** The one running issue in a lane, which is what the loop holds at a time. */
function activeInLane(runs: LoopRun[], lane: Lane): LoopRun | undefined {
  return runs.find((run) => run.lane === lane && run.status === 'running');
}

function LaneSummary({ runs }: { runs: LoopRun[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {LANES.map((lane) => {
        const active = activeInLane(runs, lane);
        return (
          <div
            key={lane}
            className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-900 dark:text-white">
                Lane {lane}
              </span>
              <span className="text-xs text-gray-500">
                {active ? agentName(active.agent) : laneAgent(lane)}
              </span>
            </div>
            {active ? (
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                #{active.issue} · {phaseLabel(active.phase)}
              </p>
            ) : (
              <p className="mt-2 text-sm text-gray-400">Idle</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AgentLoopPage() {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuthStore();
  const { board, enabled, connection } = useAgentLoop();

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <AppHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-4 py-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Agents</h1>
          {enabled && (
            <span
              className={
                connection === 'open'
                  ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300'
                  : 'rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-800'
              }
            >
              {connection === 'open' ? 'live' : 'reconnecting…'}
            </span>
          )}
        </div>
        <p className="mb-6 mt-1 text-sm text-gray-500 dark:text-gray-400">
          The autonomous loop that dispatches Claude Code, Codex, and Cursor at the issue queue —
          what each is doing now, and the controls to start or stop it.
        </p>

        {isAuthLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : !isAuthenticated ? (
          <AuthMethodPicker />
        ) : !enabled ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
            The agent-loop dashboard is turned off on this server. Set{' '}
            <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">AGENT_LOOP_ENABLED=1</code>{' '}
            (it is on by default outside production) and reload.
          </div>
        ) : !board ? (
          <p className="text-sm text-gray-500">Connecting to the loop…</p>
        ) : (
          <div className="space-y-6">
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <LoopControls status={board.status} />
            </div>

            <LaneSummary runs={board.runs} />

            <section>
              <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
                Runs {board.runs.length > 0 && `(${board.runs.length})`}
              </h2>
              {board.runs.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No runs yet. Start the loop, or run <code>pnpm loop</code> in the repository.
                </p>
              ) : (
                <div className="space-y-2">
                  {board.runs.map((run) => (
                    <RunCard key={run.issue} run={run} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
