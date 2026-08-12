import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, GitBranch, Loader2, Play } from 'lucide-react';
import { proposeArchitecture } from '@infracanvas/core';
import { AppHeader } from '@/components/layout/AppHeader';
import { ProfileSummary } from '@/components/analysis/ProfileSummary';
import { ArchitectureProposalPanel } from '@/components/analysis/ArchitectureProposalPanel';
import { AnalysisProgressPanel } from '@/components/analysis/AnalysisProgressPanel';
import { Button } from '@/components/ui/button';
import {
  activeAnalysis,
  useAnalyses,
  useRepository,
  useRunAnalysis,
} from '@/lib/hooks/use-repositories';
import { useAnalysisProgress } from '@/lib/hooks/use-analysis-progress';

export function RepositoryPage() {
  const { id } = useParams<{ id: string }>();

  const { data: repository, isLoading, error } = useRepository(id);
  const { data: analyses } = useAnalyses(id);
  const runAnalysis = useRunAnalysis(id);

  // The newest successful run is what the architecture is built from; a later
  // failed attempt should not erase the profile the user was looking at.
  const latestProfile = useMemo(
    () => analyses?.find((analysis) => analysis.status === 'succeeded')?.profile ?? null,
    [analyses]
  );

  const latestFailure = useMemo(
    () => (analyses?.[0]?.status === 'failed' ? analyses[0] : null),
    [analyses]
  );

  const proposal = useMemo(() => {
    if (!latestProfile || !repository) return null;
    return proposeArchitecture(latestProfile, repository.githubName);
  }, [latestProfile, repository]);

  // Watch whichever run is in flight, whether this tab started it or another one
  // did. Read from the analyses list rather than from the mutation, so a reload
  // mid-analysis still shows progress instead of an idle page.
  const running = useMemo(() => activeAnalysis(analyses), [analyses]);
  const progress = useAnalysisProgress(id, running?.id ?? null);

  // Queued counts as busy: the work has been asked for, and offering the button
  // again would only earn a 409 from the one-active-run rule.
  const busy = runAnalysis.isPending || running !== null;

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <AppHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-4 py-8">
        <Link
          to="/repositories"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Repositories
        </Link>

        {isLoading && <p className="text-sm text-gray-500">Loading…</p>}

        {error && (
          <p className="text-sm text-red-600">
            That repository could not be loaded. It may have been disconnected.
          </p>
        )}

        {repository && (
          <>
            <div className="mb-8 flex items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
                  {repository.githubOwner}/{repository.githubName}
                </h1>
                <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
                  <GitBranch className="h-3.5 w-3.5" />
                  {repository.defaultBranch}
                </p>
              </div>

              <Button onClick={() => runAnalysis.mutate(undefined)} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Analysing…
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    {latestProfile ? 'Re-run analysis' : 'Analyse repository'}
                  </>
                )}
              </Button>
            </div>

            {runAnalysis.error && (
              <p className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {runAnalysis.error instanceof Error
                  ? runAnalysis.error.message
                  : 'The analysis could not be started.'}
              </p>
            )}

            {progress && running && (
              <AnalysisProgressPanel progress={progress} branch={running.ref} />
            )}

            {latestFailure?.error && !busy && (
              <p className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                The last analysis failed: {latestFailure.error}
              </p>
            )}

            {!latestProfile && !busy && (
              <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-900">
                <p className="mb-1 font-medium text-gray-900 dark:text-white">
                  This repository has not been analysed yet
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  The analysis reads the dependency manifests, Dockerfiles, and language breakdown
                  on <span className="font-mono">{repository.defaultBranch}</span> to work out what
                  the application needs.
                </p>
              </div>
            )}

            {latestProfile && (
              <div className="space-y-8">
                <section>
                  <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
                    What this repository is
                  </h2>
                  <ProfileSummary profile={latestProfile} />
                  <p className="mt-3 font-mono text-xs text-gray-400">
                    {latestProfile.ref} @ {latestProfile.commitSha.slice(0, 7)}
                  </p>
                </section>

                {proposal && <ArchitectureProposalPanel proposal={proposal} />}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
