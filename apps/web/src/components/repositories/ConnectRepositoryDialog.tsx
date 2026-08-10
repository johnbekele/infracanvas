import { useMemo, useState } from 'react';
import { Lock, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConnectRepository, useGitHubRepositories } from '@/lib/hooks/use-repositories';
import { cn } from '@/lib/utils';

interface ConnectRepositoryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Repositories already connected, so they can be marked rather than offered again. */
  connectedFullNames: Set<string>;
}

export function ConnectRepositoryDialog({
  open,
  onClose,
  connectedFullNames,
}: ConnectRepositoryDialogProps) {
  const [search, setSearch] = useState('');
  // Only fetched once the dialog is open, so opening the page costs nothing.
  const { data: repos, isLoading, error } = useGitHubRepositories(open);
  const connect = useConnectRepository();

  const filtered = useMemo(() => {
    if (!repos) return [];
    const term = search.trim().toLowerCase();
    if (!term) return repos;
    return repos.filter((repo) => repo.full_name.toLowerCase().includes(term));
  }, [repos, search]);

  if (!open) return null;

  const handleConnect = async (owner: string, name: string) => {
    await connect.mutateAsync({ owner, repo: name });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Connect a repository
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Pick one of your GitHub repositories to analyse.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="border-b border-gray-200 px-5 py-3 dark:border-gray-800">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search repositories"
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading && (
            <p className="px-3 py-8 text-center text-sm text-gray-500">
              Loading your repositories…
            </p>
          )}

          {error && (
            <p className="px-3 py-8 text-center text-sm text-red-600">
              Could not load your repositories. Check that you are signed in to GitHub.
            </p>
          )}

          {!isLoading && !error && filtered.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-gray-500">
              {search ? 'No repository matches that search.' : 'No repositories found.'}
            </p>
          )}

          {filtered.map((repo) => {
            const alreadyConnected = connectedFullNames.has(repo.full_name);

            return (
              <div
                key={repo.id}
                className={cn(
                  'flex items-center justify-between gap-4 rounded-lg px-3 py-2.5',
                  'hover:bg-gray-50 dark:hover:bg-gray-800'
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900 dark:text-white">
                      {repo.full_name}
                    </span>
                    {repo.private && <Lock className="h-3 w-3 shrink-0 text-gray-400" />}
                  </div>
                  {repo.description && (
                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {repo.description}
                    </p>
                  )}
                </div>

                <Button
                  size="sm"
                  variant={alreadyConnected ? 'ghost' : 'outline'}
                  disabled={alreadyConnected || connect.isPending}
                  onClick={() => handleConnect(repo.owner.login, repo.name)}
                >
                  {alreadyConnected ? 'Connected' : 'Connect'}
                </Button>
              </div>
            );
          })}
        </div>

        {connect.error && (
          <p className="border-t border-gray-200 px-5 py-3 text-sm text-red-600 dark:border-gray-800">
            {connect.error instanceof Error
              ? connect.error.message
              : 'Could not connect that repository.'}
          </p>
        )}
      </div>
    </div>
  );
}
