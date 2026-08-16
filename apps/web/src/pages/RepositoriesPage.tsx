import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';

import { AppHeader } from '@/components/layout/AppHeader';
import { ConnectRepositoryDialog } from '@/components/repositories/ConnectRepositoryDialog';
import { RepositoryCard } from '@/components/repositories/RepositoryCard';
import { PortfolioSummary } from '@/components/repositories/PortfolioSummary';
import { Button } from '@/components/ui/button';
import { AuthMethodPicker } from '@/components/auth';
import { useAuthStore } from '@/lib/stores/auth-store';
import {
  useConnectedRepositories,
  useDisconnectRepository,
  useRunAnalysisFor,
} from '@/lib/hooks/use-repositories';

export function RepositoriesPage() {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuthStore();
  const [isPickerOpen, setPickerOpen] = useState(false);

  const { data: repositories, isLoading } = useConnectedRepositories();
  const disconnect = useDisconnectRepository();
  const analyse = useRunAnalysisFor();

  const connectedFullNames = useMemo(
    () => new Set((repositories ?? []).map((repo) => `${repo.githubOwner}/${repo.githubName}`)),
    [repositories]
  );

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <AppHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-4 py-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Your work</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Connect a repository and this reads what it is built from, proposes an architecture
              that would run it, and prices what that would cost before anything is deployed.
            </p>
          </div>

          {isAuthenticated && (
            <Button onClick={() => setPickerOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Connect repository
            </Button>
          )}
        </div>

        {!isAuthLoading && !isAuthenticated && (
          <div className="mx-auto max-w-md rounded-xl border border-dashed border-gray-300 bg-white p-10 dark:border-gray-700 dark:bg-gray-900">
            <p className="mb-4 text-center text-sm text-gray-600 dark:text-gray-400">
              Sign in with GitHub to connect a repository.
            </p>
            <AuthMethodPicker />
          </div>
        )}

        {isAuthenticated && (
          <>
            {isLoading && <p className="text-sm text-gray-500">Loading…</p>}

            {!isLoading && repositories?.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-900">
                <p className="mb-1 font-medium text-gray-900 dark:text-white">
                  No repositories connected yet
                </p>
                <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
                  Pick one of your GitHub repositories to get started.
                </p>
                <Button onClick={() => setPickerOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Connect repository
                </Button>
              </div>
            )}

            {repositories !== undefined && repositories.length > 0 && (
              <PortfolioSummary repositories={repositories} />
            )}

            <div className="space-y-3">
              {repositories?.map((repository) => (
                <RepositoryCard
                  key={repository.id}
                  repository={repository}
                  onDisconnect={(id) => disconnect.mutate(id)}
                  onAnalyse={(id) => analyse.mutate(id)}
                  isDisconnecting={disconnect.isPending}
                />
              ))}
            </div>
          </>
        )}
      </main>

      <ConnectRepositoryDialog
        open={isPickerOpen}
        onClose={() => setPickerOpen(false)}
        connectedFullNames={connectedFullNames}
      />
    </div>
  );
}
