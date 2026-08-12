import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, GitBranch, Loader2, Lock, Play, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { summariseProposal } from '@/lib/analysis/estimate-proposal';
import { money, percent } from '@/lib/estimate/format';
import type { RepositoryWithState } from '@/lib/api/repositories';

interface RepositoryCardProps {
  repository: RepositoryWithState;
  onDisconnect: (id: string) => void;
  onAnalyse: (id: string) => void;
  isDisconnecting: boolean;
}

/**
 * One repository, with what is known about it and one thing to do next.
 *
 * The card states the outcome rather than the mechanism: what the architecture
 * would cost a month, how available it is modelled to be, and what would stop it
 * being deployed as drawn. A card that only repeats the repository's name makes
 * the user open it to find out whether anything happened, which is the state
 * this page existed in before.
 *
 * The action is singular by design. A row of equally weighted buttons asks the
 * user to decide what this tool is for; the card decides, from the state it is
 * in, and offers the rest through the card body.
 */
export function RepositoryCard({
  repository,
  onDisconnect,
  onAnalyse,
  isDisconnecting,
}: RepositoryCardProps) {
  const navigate = useNavigate();
  const { latest, succeeded } = repository;
  const running = latest?.status === 'pending' || latest?.status === 'running';

  const summary = useMemo(
    () => summariseProposal(succeeded?.architecture ?? null),
    [succeeded?.architecture]
  );

  const fullName = `${repository.githubOwner}/${repository.githubName}`;

  return (
    <div className="group rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-violet-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-violet-700">
      <div className="flex items-start justify-between gap-4">
        <Link to={`/repositories/${repository.id}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-gray-900 dark:text-white">{fullName}</span>
            {repository.isPrivate && <Lock className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
            <span className="flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5" />
              {repository.defaultBranch}
            </span>
            <StateLine
              running={running}
              status={latest?.status ?? null}
              finishedAt={latest?.finishedAt ?? null}
              commitSha={succeeded?.commitSha ?? null}
            />
          </div>
        </Link>

        <div className="flex shrink-0 items-center gap-1">
          {summary === null ? (
            <Button size="sm" disabled={running} onClick={() => onAnalyse(repository.id)}>
              {running ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Analysing
                </>
              ) : (
                <>
                  <Play className="mr-2 h-3.5 w-3.5" />
                  Analyse
                </>
              )}
            </Button>
          ) : (
            <Button size="sm" onClick={() => navigate(`/repositories/${repository.id}`)}>
              Open architecture
              <ArrowRight className="ml-2 h-3.5 w-3.5" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            disabled={isDisconnecting}
            onClick={() => onDisconnect(repository.id)}
            aria-label={`Disconnect ${fullName}`}
          >
            <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-600" />
          </Button>
        </div>
      </div>

      {summary !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-gray-100 pt-3 text-xs dark:border-gray-800">
          <Figure label="Predicted" value={`${money(summary.monthlyUsd)}/mo`} />
          <Figure label="Available" value={percent(summary.availability)} />
          <Figure
            label="Services"
            value={`${summary.serviceCount}`}
            hint={
              summary.unpricedCount > 0
                ? `${summary.unpricedCount} not priced yet, so the total is a floor`
                : undefined
            }
          />
          {summary.findings > 0 && (
            <span
              className={
                summary.highSeverity > 0
                  ? 'flex items-center gap-1.5 text-rose-700 dark:text-rose-400'
                  : 'flex items-center gap-1.5 text-amber-700 dark:text-amber-400'
              }
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {summary.highSeverity > 0
                ? `${summary.highSeverity} to fix before deploying`
                : `${summary.findings} to decide about`}
            </span>
          )}
        </div>
      )}

      {latest?.status === 'failed' && latest.error !== null && (
        <p className="mt-3 flex items-start gap-1.5 border-t border-gray-100 pt-3 text-xs text-rose-700 dark:border-gray-800 dark:text-rose-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          The last analysis failed: {latest.error}
        </p>
      )}
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <span className="flex items-baseline gap-1.5" title={hint}>
      <span className="text-gray-400">{label}</span>
      <span className="font-medium text-gray-900 dark:text-white">{value}</span>
      {hint !== undefined && <span className="text-gray-400">*</span>}
    </span>
  );
}

/** When it last ran and what came of it, in the tense the user would use. */
function StateLine({
  running,
  status,
  finishedAt,
  commitSha,
}: {
  running: boolean;
  status: string | null;
  finishedAt: string | null;
  commitSha: string | null;
}) {
  if (running) return <span className="text-violet-600 dark:text-violet-400">Analysing now</span>;
  if (status === null) return <span>Never analysed</span>;

  const when = finishedAt === null ? null : relative(finishedAt);
  return (
    <span className="truncate">
      {status === 'failed' ? 'Failed' : 'Analysed'}
      {when !== null && ` ${when}`}
      {commitSha !== null && status !== 'failed' && (
        <span className="ml-1.5 font-mono text-gray-400">{commitSha.slice(0, 7)}</span>
      )}
    </span>
  );
}

/** Coarse on purpose: nobody reads a list of repositories to learn the minute. */
function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
